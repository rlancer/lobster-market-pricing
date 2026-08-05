# Distributed CBOE Loaders Orchestrated via Cloudflare D1 (Plan)

**Status:** proposed (not yet implemented)
**Date:** 2026-08-05
**Owner:** screener_glm52
**Depends on:** the CBOE hard cutover (plans/2026-08-05-cboe-data-pipeline-github-actions.md)

## TL;DR

Evolve the single GitHub Actions CBOE loader into a **fleet of distributed loaders**
coordinated by a **Cloudflare D1 database** as the central source of truth, exposed
through a small coordination Worker. Machines (GitHub runners, personal computers, edge
Workers) **register as loaders**, **claim symbol work-units**, fetch CBOE, and report
results back through the coordinator. D1 gives us the resume/retry/freshness bookkeeping
that the current single-runner design handles crudely (a per-run `run_id` + `download_log`
inside a reset-every-time DuckDB file).

This is a **plan only** — no implementation.

---

## 1. Why (the problem with the current single loader)

The cutover plan moves to one GitHub Actions cron job that pulls all ~503 S&P 500 symbols
from CBOE into a local DuckDB, exports to Parquet, and uploads to R2. Observations:

- **CBOE rate-limits (429)** when a single source hammers it (we hit it ~484 symbols into a
  full run at 0.25s sleep; backoff + slower sleep recovers but the run is long).
- **A single full refresh is slow** (~15–25 min wall-clock) because it's one serial stream.
- **Resume is all-or-nothing**: `run()` does a full `reset()` then re-pulls everything; if
  it's killed mid-write the DB is left inconsistent (we saw exactly this). There's no
  per-symbol durable progress *across* runs.
- **One machine = one point of failure** for freshness; GitHub Actions scheduler is a known
  flaky stopgap.

Distributing the work across several loaders (more sources, more parallel streams) both
fixes throughput and removes the single-point-of-failure — but only if the pieces can
coordinate without stepping on each other. **D1 is that coordination layer.**

## 2. Goals

1. N independent loaders fetch disjoint/sharded CBOE work, coordinated by D1.
2. **Durable, resumable work tracking**: every symbol is a discrete work-unit with a
   per-symbol status; progress survives crashes, machines leaving, and re-runs. No full
   reset.
3. **Self-healing**: a loader that dies mid-symbol (its claim expires) has its work
   reassigned to another loader automatically.
4. **Rate-limit friendly**: loaders self-throttle individually; D1 only coordinates, so N
   loaders = up to ~N× safe throughput within CBOE's per-IP limits.
5. **Freshness policy**: D1 tracks `last_fetched` per symbol so we can do delta refreshes
   after each market close (and optionally intraday) instead of always re-pulling all 503.
6. Keeps a **clean, publishable dataset**: only a complete-enough/fresh-enough snapshot is
   aggregated to Parquet and promoted to R2 (never a partial overwrite).
7. Reuses the **isolated CBOE fetch module** from `download_cboe.py` (`parse_occ` /
   `normalize_option`) so loaders share one normalization implementation (and a TS port
   can be a Worker loader).

## 3. Core concept: D1 as the coordination database

D1 is Cloudflare's serverless SQLite. We use it as the **central bookkeeper** — it holds
*work state and metadata*, not the 500k option rows (those live in R2 Parquet fragments).

Why D1 over the alternatives:

| Option | Why not |
|---|---|
| **D1** | ✅ Transactional SQL: atomic claim (`UPDATE ... WHERE status='pending'`), SELECT for scheduling, constraints. ACID across concurrent loaders. Free tier is generous for this volume of metadata. **Pick this.** |
| Workers KV | Eventually-consistent; no SQL/transactions — claiming work races badly. |
| R2 (object store) | No queries/locking; unsuitable as a coordination ledger. |
| Local DuckDB (status quo) | Per-machine only; can't coordinate *across* loaders. |

## 4. D1 schema (proposed)

```sql
-- Registered loader instances. A machine registers once per boot and heartbeat
-- every ~30s; the coordinator treats a loader as dead if no heartbeat for ~2min.
CREATE TABLE loaders (
    id            TEXT PRIMARY KEY,          -- uuid per loader instance
    hostname      TEXT NOT NULL,
    kind          TEXT NOT NULL,             -- 'gh-actions' | 'local' | 'worker'
    registered_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',   -- active | draining | dead
    current_batch TEXT                         -- job_id currently held (nullable)
);

-- One row per symbol. This is the resume/retry ledger.
CREATE TABLE symbol_jobs (
    symbol         TEXT PRIMARY KEY,          -- e.g. 'AAPL', 'BRK.B' (dotted kept)
    status         TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|done|error|poison
    owner_loader   TEXT,                      -- loader.id that holds the claim
    claimed_at     TEXT,                      -- when claimed (drives lease TTL)
    lease_until    TEXT,                      -- claim expires -> reassignable
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    last_fetched   TEXT,                      -- freshness timestamp
    contracts      INTEGER,                   -- last known contract count (sanity)
    payload_ref    TEXT,                      -- R2 key of this symbol's result fragment
    updated_at     TEXT
);

-- Immutable result fragments ledger (optional; for audit + aggregation).
CREATE TABLE symbol_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT NOT NULL,
    loader_id    TEXT NOT NULL,
    status       TEXT NOT NULL,               -- ok | error
    contracts    INTEGER,
    payload_ref  TEXT,                        -- R2 key of fragment
    fetched_at   TEXT NOT NULL,
    meta         TEXT                          -- json (exps, spot, errors)
);
```

**Lease mechanics (the resume trick):** every claim sets `status='claimed'`,
`owner_loader=?`, `lease_until = now + TTL` (e.g. 5 min). A loader must **heartbeat** to
extend its lease. The coordinator's `reap` routine (a scheduled Worker / cron) flips any
`claimed` row whose `lease_until < now` back to `pending` (incrementing `attempts`), so a
crashed loader's symbols are re-queued. This gives us distributed resume with zero manual
intervention.

## 5. Coordination Worker endpoints (REST, via a Cloudflare Worker)

A small Worker wraps D1 as the single coordination authority. Loaders are just HTTP
clients of it:

| Endpoint | Purpose |
|---|---|
| `POST /api/loaders/register` | Loader registers, gets its `id`; body `{hostname, kind, secret?}`. |
| `POST /api/loaders/heartbeat` | Extends lease on current claims; updates `last_heartbeat`. |
| `POST /api/work/claim` | Transactionally claims up to `N` pending symbols for a loader (with TTL). |
| `POST /api/work/submit` | Loader reports a symbol result (ok + `payload_ref`, or error). Marks `done`/`error`; clears claim. |
| `POST /api/work/reap` | (Scheduled, or internal) expires dead leases, resets stale `pending`. |
| `GET  /api/work/status` | Dashboard: pending/claimed/done/error counts, per-symbol age. |
| `POST /api/snapshot/build` | Aggregator triggers Parquet build from R2 fragments once coverage is sufficient. |

**Claiming is the heart of it** — a single SQL transaction guarantees no two loaders get
the same symbol:

```sql
-- inside the Worker, begin transaction:
-- 1) candidate = SELECT symbol FROM symbol_jobs
--    WHERE status='pending' AND symbol NOT IN (current claimed)
--    ORDER BY last_fetched ASC  -- oldest data first
--    LIMIT :N
-- 2) UPDATE symbol_jobs SET status='claimed', owner_loader=:id,
--       claimed_at=now, lease_until=now + ttl
--    WHERE symbol IN (candidate) AND status='pending'   -- conditional guards races
-- 3) commit; return affected symbols to the loader
```

## 6. Loader behavior (client side)

A loader is any process that can talk HTTP and fetch CBOE. It uses the **shared fetch
module** (`parse_occ`/`normalize_option` — already isolated in `download_cboe.py`; a TS
port is the Worker loader).

Loop:

1. `register` → get `id`.
2. `claim N` → get a batch of symbols.
3. For each symbol: fetch CBOE, **normalize** to option rows, throttle (e.g. 0.5s), on 429
   back off locally.
4. **Upload the symbol's rows to R2** as a per-symbol fragment (e.g.
   `fragments/{ts}/{symbol}.json` or parquet) — R2 is the shared data layer, so loaders
   don't need a local DuckDB at all. `payload_ref` = that key.
5. `submit(id, symbol, {status, payload_ref, contracts, spot, exps})`.
6. Heartbeat every ~30s while working.
7. Repeat until D1 reports no pending work.

Because every loader writes to **R2**, not its own disk, the pieces remain decoupled — a
loader is stateless and can be any machine.

## 7. Aggregation → Parquet → R2 (publishing)

D1 has metadata; R2 has per-symbol fragments. A **snapshot builder** (scheduled Worker, or
a local script) assembles the current Parquet:

1. Query D1 for symbol jobs with `status='done'` and `last_fetched` within the freshness
   window.
2. **Coverage gate**: only build+publish if, say, ≥ ~98% of the 503 symbols are fresh and
   no symbol is over a max age. Otherwise keep the last-good Parquet in R2 (no partial
   overwrite — same policy as the current plan).
3. Download fragments from R2, merge into `option_contracts`/`underlyings` Parquet
   (DuckDB can `read_json`/`read_parquet` the fragments) + write `manifest.json`.
4. Upload to the public `options/` bucket. D1 records the published snapshot/version.

Freshness policy (configurable): after each US market close, queue **all** stale symbols;
optionally intraday, queue symbols older than `X`. Because each symbol has its own
`last_fetched`, a run only re-pulls what's stale — this is the real fix for the
all-or-nothing full reset.

## 8. Registering real loaders (the "few computers" model)

- **GitHub Actions runner** (existing) becomes one loader (`kind='gh-actions'`) — it now
  fetches via D1 claims instead of a monolithic script, so it's just another worker.
- **Personal machines** (yours, a friend's, a VPS): shake hands with the coordinator
  (registration secret), run a tiny loader script, heartbeat. The more machines the faster
  the full refresh and the more resilient freshness becomes — no machine has to stay on
  forever; the rest pick up its claim once its lease expires.
- **Cloudflare Worker (TS)**: the ultimate always-on loader (no machine). It can claim a
  handful of symbols per scheduled invocation (D1 + R2 + CBOE all within the Workers
  platform), staying under the 128MB / cron wall-clock limits by processing **per symbol**,
  never buffering the whole 500MB scan. This is the natural end-state and the reason the
  fetch module is kept isolated/portable.

## 9. Failure handling summary

| Failure | Mechanism |
|---|---|
| Loader crashes mid-batch | Claim lease expires → `reap` resets to `pending` → another loader claims it. |
| CBOE 429 / 5xx | Loader local backoff + retries; permanent 404 → `poison` (never retried). |
| Loader returns bad/partial result | `contracts` sanity check; low/zero counts flagged; symbol re-queued. |
| Some symbols stale at publish time | Coverage gate blocks publish; last-good Parquet stays in R2. |
| Loader "dies" permanently | `status='dead'` via stale heartbeat; its symbols drain via lease expiry. |

## 10. Security & operations

- Loader registration uses a shared **secret** (D1 or Worker secret) so random machines
  can't hijack work or poison state.
- Heartbeats are cheap; capability-driven claim sizes (cap `N` per loader by `kind`).
- D1 free tier is ample here (one row per symbol + one per result ≈ trivial vs 5M
  rows/day). All loaders self-throttle; D1 does no CBOE fetching.
- Observability: `GET /api/work/status` + R2 fragment listing gives a live picture of
  freshness and which loader did what.

## 11. Phased rollout

- **Phase 0 (now):** keep the single GH Actions CBOE loader (working, hardened).
- **Phase 1:** stand up D1 schema + coordination Worker + make the GH Actions job a D1
  loader (claim/submit). This alone fixes resume & adds a freshness ledger with no new
  machines.
- **Phase 2:** add the per-symbol R2 fragment writer + snapshot builder; decouple loaders
  from local DuckDB.
- **Phase 3:** register additional local/VPS loaders; optionally the TS Worker loader for
  always-on coverage.
- **Phase 4 (optional):** intraday delta refreshes driven by per-symbol `last_fetched`.

## 12. Open questions / decisions

- **Freshness window & coverage gate thresholds** (how fresh is "fresh", what % to publish).
- **Fragment format**: JSON-per-symbol (simple, ~MB each) vs Parquet-per-symbol
  (DuckDB-native). JSON is easier for Worker/TS loaders; Parquet is lighter. Decide in Phase 2.
- **Default loader fleet**: start with GH Actions + local machines, or jump straight to a
  Worker loader?
- **CBOE per-IP vs global limits**: with N machine loaders (distinct IPs) we multiply
  throughput; if CBOE limits globally we'd need to stay modest regardless.
- **Cleanup of R2 fragments & D1 rows** (retention policy) so storage doesn't grow unbounded.
- Whether to keep the deterministic single-source snapshot as a fallback if D1 is
  unavailable (a read-mostly coordinator that's cheap but not critical-path — network
  egress to D1 could become the availability concern).

## 13. Relationship to the existing codebase

- **Reuse:** `download_cboe.py` `parse_occ`/`normalize_option`/`fetch_symbol` are the exact
  functions a loader (Python or TS) calls. `sp500.py` seeds `symbol_jobs` on first run.
- **Replace:** the monolithic `run()`/`reset()`/`download_log` resume model in
  `download_cboe.py` (a local, single-machine artifact) in favor of D1-backed
  `symbol_jobs`.
- **Frontend / Parquet format:** unchanged — the app still reads `option_contracts.parquet`
  + `underlyings.parquet` + `manifest.json` from R2. Only how the Parquet is assembled
  changes (aggregator instead of a single export step).

---

*This is a planning document. Nothing here is implemented yet.*
