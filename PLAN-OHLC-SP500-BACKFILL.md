# PLAN — S&P 500 OHLC Backfill (2y), Underlyings Refactor, Symbology, Corporate Actions

Status: PLANNING — to be executed in a fresh context.
Owner: rlancer. Created 2026-08-08. Source decision: **Yahoo to start** (confirmed by
owner; see Source section). Existing `OPEN_FIGI` key is in root `.env` for symbology.

This is an execution-runbook-style plan: each section gives the current grounded
state, the decision, and the concrete steps a fresh session should take (with the
same merge/deploy/verify discipline as `PR #13`'s runbook).

---

## 1. Goals

1. **Backfill daily OHLC + realized vol for the full S&P 500 universe for the past 2
   years**, into the R2 Iceberg lake (`options.ohlc`, `options.realized_vol`), with
   proper idempotency, correct handling of **stock splits / corporate actions**, and
   tolerance for **ticker changes** during the window.
2. **Refactor `options.underlyings`** — it currently serves double duty (descriptive
   security master *and* per-run snapshot history). Split into purpose-built tables.
3. **Add a symbology / security-identity layer** (OpenFIGI-style) so a stable
   instrument identity survives ticker renames (e.g. `FB → META`) and so backfill can
   join history across a rename.

---

## 2. Current grounded state

### 2.1 Data sources (loader)
- OHLC+realized-vol enrichment: `loader/src/ohlc.ts`. Source is **Yahoo chart v8**
  (`DEFAULT_OHLC_URL_TEMPLATE = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1y&interval=1d"`).
  - Parse `parseYahooChart` → `DailyBar[]` (open/high/low/close/volume, ascending by date).
  - `realizedVols` → 30d & 90d realized vol from trailing log-returns, annualized ×√252.
  - Publish: `normalizeOhlcRecords` → `options.ohlc`; `normalizeRealizedVolRecord` → `options.realized_vol`.
  - **`range=1y` is hardcoded.** The URL template supports `{symbol}` only; the whole
    range is fixed. A 2y backfill therefore needs `period1`/`period2` (epoch) params and
    a configurable template — see Backfill.
- CBOE options path: `loader/src/run-symbols.ts` (contracts + underlyings + runs +
  errors). CBOE does **not** provide historical daily OHLC, so Yahoo stays the OHLC
  source (owner-confirmed).

### 2.2 Lake tables (R2 Iceberg, via Cloudflare Pipelines)
Schemas in `loader/schemas/*.json`; the tables are **sink-created and append-only**,
stream schemas are **immutable** (see AGENTS gotchas: recreate stream→sink→table to
change schema; do not pre-create a table the sink targets — `1012`).

| Table | Schema (cols) | Notes |
|---|---|---|
| `options.option_contracts` | symbol, expiration(TEXT), type, strike, last, bid, ask, volume, open_interest, implied_vol, delta, gamma, theta, vega, rho, in_the_money, theo, bid_size, ask_size, run_id, as_of_date, fetched_at, __ingest_ts | append-only |
| `options.underlyings` | symbol, name, sector, spot_price, description, run_id, as_of_date, fetched_at | **dual-purpose** — see 2.3 |
| `options.refresh_runs` | run_id, started_at, completed_at, as_of_date, expected_symbols, successful_symbols, failed_symbols, contract_count, status, error_summary | run ledger |
| `options.ohlc` | symbol, date, open, high, low, close, volume, source, run_id, as_of_date, fetched_at | append-only, **no PK** |
| `options.realized_vol` | symbol, as_of_date, realized_vol_30d, realized_vol_90d, n_returns_30, n_returns_90, run_id, fetched_at | latest snapshot per symbol + run |

### 2.3 `underlyings` — the dual-purpose problem (grounded)
Referenced everywhere via the `LATEST_UNDERLYING` pattern
(`QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1`):
- As a **security master**: `symbol`, `name`, `sector`, `description` (slow-moving facts).
- As a **run history**: `spot_price`, `run_id`, `as_of_date`, `fetched_at` (append per CBOE refresh).

These have different shapes, lifespans, and update cadences. Conflating them means:
every options refresh appends new rows even when the descriptive facts didn't change,
and there's no place to hold a *stable* instrument identity that survives a rename.
→ Split into: **security master** (identity + descriptive), **underlying snapshots**
(spot/price history per run), plus a **symbol history** mapping (symbology).

### 2.4 Jobs / scheduler
- Scheduler: `EtlScheduler` DO (`loader/src/scheduler.ts`), D1 `job_state` ledger
  (migration `0002_job_state.sql`). Job registry: `loader/src/jobs/registry.ts`.
- Registered jobs: `cboe-options` (item-scoped, market-gated, items in `symbol_state`)
  and `ohlc-daily` (batch, `scope:"batch"`, ungated, daily cadence 86400, whole
  universe = `sp500.json` symbols).
- `ohlc-daily` (`loader/src/jobs/ohlc-daily.ts`): for each symbol calls `publishOhlc`;
  **batch scope means the whole universe runs each pass but the job is cadence
  (not item-store) driven — not resumable per-symbol.** Concurrency default 4
  (`OHLC_CONCURRENCY`). Dry-runs (no-op) when no Pipeline URLs.
- Manual trigger: `POST /jobs/{id}/trigger` (Bearer `LOADER_TOKEN`).

---

## 3. Source decision

**Keep Yahoo for OHLC (owner-confirmed "use yahoo to start").**
- Tradeoff: Yahoo is ToS-gray for commercial redistribution (DATA-ENRICHMENT.md) — fine
  for a personal screener, not for serving `/api/query` to third parties. Revisit later
  (CBOE DataShop/OPRA equity EOD is paid; Stooq rejected in prototype).
- Yahoo already returns **split-adjusted** OHLC for `interval=1d` when queried with
  `events=div,split` (it also returns `adjclose` and an `events` block with `dividends`
  and `splits`). We will request `events=div,split` and persist both the adjusted bars
  and the raw split events (see Corporate actions).
- **CBOE stays the options source** (contracts/underlyings spot). OHLC is a separate,
  Yahoo-backed pipeline. No cross-vendor change to the options path.

---

## 4. Schema refactor — proposed tables

Migrations are per-`Pipeline` (Iceberg) so schema changes = new streams + sinks +
tables. **Do not ALTER existing tables** (immutable / `1012` constraint). Newly created
tables are sink-created; ship a matching `loader/schemas/<name>.json` and recreate the
pipeline wiring (see PR #13's OHLC provision runbook for the exact commands).

### 4.1 `options.securities` — security master (new)
One row **per stable instrument identity** (highest grain: the *issuer/depositary
receipt share class*), descriptive, slow-moving. This is the new "master".

```jsonc
{
  "fields": [
    {"name":"security_id","type":"string","required":true},   // stable internal UUID
    {"name":"ticker","type":"string","required":true},         // current ticker
    {"name":"name","type":"string","required":false},
    {"name":"sector","type":"string","required":false},
    {"name":"exchange","type":"string","required":false},
    {"name":"currency","type":"string","required":false},
    {"name":"figi","type":"string","required":false},          // OpenFIGI FIGI, if mapped
    {"name":"composite_figi","type":"string","required":false},
    {"name":"isin","type":"string","required":false},
    {"name":"run_id","type":"string","required":true},
    {"name":"as_of_date","type":"string","required":true},
    {"name":"fetched_at","type":"string","required":true}
  ]
}
```
- Append-only; "current" read = `QUALIFY ROW_NUMBER() OVER (PARTITION BY security_id
  ORDER BY fetched_at DESC) = 1`.
- `security_id` is the stable key that **outlives ticker renames**; `figi`/`composite_figi`
  are the OpenFIGI-native stable identifiers we enrich against.

### 4.2 `options.symbol_history` — ticker↔security mapping (new; symbology)
Tracks **which ticker a security traded under at which time** (SCD-II style, append
with `valid_from`/`valid_to`). This is what lets backfill resolve `FB` → the same
security as `META`.

```jsonc
{
  "fields": [
    {"name":"security_id","type":"string","required":true},
    {"name":"ticker","type":"string","required":true},
    {"name":"valid_from","type":"string","required":true},    // YYYY-MM-DD (inclusive)
    {"name":"valid_to","type":"string","required":false},      // NULL = current
    {"name":"is_current","type":"int64","required":true},      // 1/0 convenience flag
    {"name":"reason","type":"string","required":false},        // e.g. "rename","add","delist"
    {"name":"run_id","type":"string","required":true},
    {"name":"fetched_at","type":"string","required":true}
  ]
}
```
- Backfill join: for a given `(security_id, trade_date)`, pick the row where
  `valid_from <= trade_date` and (`valid_to` is NULL or `valid_to >= trade_date`), and
  query the historical OHLC under that ticker.
- Future: when the current ticker is a rename, we backfill the pre-rename period off the
  **old** ticker, keep continuity by `security_id`.

### 4.3 `options.underlying_snapshots` — run history (decoupled from master)
The old "run history" half of `underlyings`, kept append-only at snapshot cadence:

```jsonc
{
  "fields": [
    {"name":"security_id","type":"string","required":true},
    {"name":"ticker","type":"string","required":true},         // as-of ticker (denormalized for query ease)
    {"name":"spot_price","type":"float64","required":false},
    {"name":"name","type":"string","required":false},          // denormalized copy (optional)
    {"name":"sector","type":"string","required":false},
    {"name":"run_id","type":"string","required":true},
    {"name":"as_of_date","type":"string","required":true},
    {"name":"fetched_at","type":"string","required":true}
  ]
}
```
- **Decision (default):** create the three new tables above. Keep `options.underlyings`
  publishing for back-compat **during** migration, then **retire it** once the frontend/
  worker read paths are repointed to `securities` + `underlying_snapshots`. The Worker
  (`worker/src/index.ts`) `LATEST_UNDERLYING` and frontend (`App.tsx`, `SymbolDetail.tsx`,
  `api.ts`) must be updated. This cutover is load-bearing (see Risks).

### 4.4 `options.ohlc` — add stable keying (existing table, but fix idempotency)
Current rows have no uniqueness; every `ohlc-daily` pass re-publishes the full trailing
window under a new `run_id`/`fetched_at`, causing **duplicate (symbol,date) rows
accumulate**. Options:
1. **Preferred:** treat `(security_id, date)` as the logical key and rely on latest-`fetched_at`
   dedupe at read (`QUALIFY ROW_NUMBER() OVER (PARTITION BY security_id, date ORDER BY
   fetched_at DESC)=1`). Backfill becomes idempotent: re-running a window overwrites
   logical rows with newer `fetched_at`.
2. Cleaner alternative requiring a schema change: recreate `ohlc` with a `security_id`
   column (rename the current table and rebuild). Heavier; do only if we also need to
   carry `security_id` in `ohlc`.
- **Recommendation:** keep `ohlc` append-only, add `security_id` via a **new** sink only
  if we want identity in OHLC; otherwise add a `security_id` join through `symbol_history`.
  Simplest correct start: leave `ohlc` schema, key on `(symbol, date)`, dedupe latest at
  read. Backfill writes a single consolidated `run_id` so the latest-wins dedupe is stable.

### 4.5 `options.corporate_actions` — splits/dividends (new)
Yahoo `events` block gives `dividends` and `splits` per bar series. Persist them so
realized-vol and any future backtests are split-aware.

```jsonc
{
  "fields": [
    {"name":"security_id","type":"string","required":true},
    {"name":"ticker","type":"string","required":true},
    {"name":"action_type","type":"string","required":true},   // "SPLIT" | "DIVIDEND"
    {"name":"ex_date","type":"string","required":true},        // YYYY-MM-DD
    {"name":"numerator","type":"float64","required":false},    // split: 4 (4-for-1)
    {"name":"denominator","type":"float64","required":false},  // split: 1
    {"name":"amount","type":"float64","required":false},       // dividend cash
    {"name":"source","type":"string","required":true},
    {"name":"run_id","type":"string","required":true},
    {"name":"fetched_at","type":"string","required":true}
  ]
}
```

---

## 5. Backfill job spec — S&P 500, 2y OHLC

### 5.1 Yahoo request parameters
Change the fetch to a **date-range** request (Yahoo supports `period1`/`period2` epoch
seconds, mutually exclusive with `range`). Make it configurable:
- New env: `OHLC_URL_TEMPLATE` already exists but only substitutes `{symbol}`. Extend to
  support `{period1}`/`{period2}` (or build the URL in the backfill job).
- Request includes `events=div%2Csplit` so we get `adjclose` + dividends + splits.
- `interval=1d`, `range` → drop, use `period1`/`period2`.

The loader `ohlc.ts` `parseYahooChart` must read `adjclose` and the `events` block
(dividends/splits) in addition to `quote` OHLC. Add a `corporate_actions` emission from
the same response.

### 5.2 Window & math
- Window: **past 2 years ≈ 504 trading days** per symbol, × ~500 symbols ≈ **~250k rows**.
- Yahoo rate limit: unauthenticated chart API throttles; use bounded concurrency
  (`OHLC_CONCURRENCY`, keep modest e.g. 4–6) and rely on existing retry/backoff
  (`HTTP_RETRIES`, `RETRY_BACKOFF_SECONDS`). The full backfill will take a while — run it
  as a **dedicated job**, not the daily `ohlc-daily` cadence.

### 5.3 Job design
Add a new registered job `ohlc-backfill` (`scope:"batch"`, ungated, epoch `cadence` ~
`0`/once) driven manually via `POST /jobs/ohlc-backfill/trigger` (Bearer `LOADER_TOKEN`),
or a one-off local `wrangler dev` run of a new `tools/ohlc_backfill.ts` that walks the
universe and calls `publishOhlcRange(symbol, period1, period2, env)`.
- **Resumability:** batch scope isn't item-resumable. If it must survive long runs, make
  `ohlc-backfill` **item-scoped** with a D1 `ohlc_backfill_state` item store
  (mirror `symbol_state`), keyed per `(security_id, ticker)`, so a pass only re-picks
  unfinished items. Prefer item-scoped + manual trigger for a 2y backfill.
- Emit a `run_id` per backfill pass; daily `ohlc-daily` continues to append new days
  (idempotent via latest-wins dedupe).

### 5.4 Split-aware realized vol
`realizedVols` computes log-returns off `close`. **Must use `adjclose`** (split- and
dividend-adjusted) for returns, else a split inserts a spurious large return. Update
`realizedVolFromCloses` to take adjusted closes. Store both raw OHLC and `adjclose`.

---

## 6. Symbology — OpenFIGI integration

- **Key:** `OPEN_FIGI` present in root `.env` (confirmed). Never commit it; add to
  `.dev.vars.example`/`.env.example` as a placeholder.
- Use OpenFIGI **Mapping API** (`POST https://api.openfigi.com/v3/mapping`, key in
  `X-OPENFIGI-APIKEY`) to resolve each ticker → `figi` + `compositeFigi` + name + ticker.
  `figi`/`compositeFigi` become the stable external identifiers in `options.securities`.
- Because a ticker can change mid-window, the **history table (`symbol_history`) is the
  source of truth for "which ticker when"**; OpenFIGI gives the canonical stable id and
  helps detect renames (e.g. resolving both `FB` and `META` to the same `compositeFigi`).
- Plan step: add a `tools/figi_map.ts` to batch-map the universe, persist `figi` into
  `securities`, and (optionally) seed `symbol_history` rename rows from OpenFIGI
  `compositeFigi` collisions.

---

## 7. Execution order (fresh context runbook)

Phase-sensitive — each step independently verifiable; merge/deploy discipline as in PR #13.

### Phase A — symbology + schema plumbing
1. Add/new `loader/schemas/`: `securities.json`, `symbol_history.json`,
   `underlying_snapshots.json`, `corporate_actions.json` (fields per §4).
2. Provision streams + sinks + pipelines + Iceberg tables for each (follow the exact
   OHLC-provision commands from PR #13 + AGENTS gotchas; sinks create tables, don't
   pre-create).
3. Add `tools/figi_map.ts`; run against the S&P universe w/ `OPEN_FIGI`; publish
   `securities` (+ `symbol_history` seeds). Verify row counts via R2 SQL.
4. Unit-test pure helpers (`npx vitest`).

### Phase B — split-aware OHLC source
5. Extend `ohlc.ts`: period1/period2 template, `events=div,split`, parse `adjclose` +
   events; realized vol off adjusted closes; emit `corporate_actions`.
6. Add tests (`src/ohlc.test.ts`): adjusted-closes realized vol, split-parsing,
   corporate-action emission. `npx tsc --noEmit` clean.

### Phase C — backfill job
7. Add `ohlc-backfill` job + (if resumable) D1 migration `0003_ohlc_backfill_state.sql`
   item store; wire into `jobs/registry.ts`; `/jobs/ohlc-backfill/trigger`.
8. Dry-run local (`wrangler dev`, no Pipeline URL) → probe a few symbols
   (`tools/ohlc_probe.ts` extended for range).
9. Manual trigger with `LOADER_TOKEN`; watch `/jobs` + logs; verify counts via R2 SQL
   (`SELECT COUNT(*) FROM options.ohlc` and per-`security_id` date coverage).

### Phase D — underlyings refactor cutover
10. Repoint Worker read paths (`LATEST_UNDERLYING` → `securities` latest +
    `underlying_snapshots` latest) and frontend (`api.ts`, `App.tsx`, `SymbolDetail.tsx`).
11. Back-compat publish `underlyings` during migration; after verified cutover, retire
    `underlyings` stream+sink+table (drop via catalog) and update docs (AGENTS/README).
12. Update `.env.example`, `.dev.vars.example`, AGENTS, README.

### Phase E — deploy + verify
13. Merge → `deploy-loader.yml` auto-deploys (D1 migrations `--remote` then `wrangler deploy`).
14. Same post-deploy checks as PR #13 runbook: `/jobs`, `/loop/status`, R2 SQL counts,
    and a split-adjusted continuity spot check (e.g. a symbol that split in the window).

---

## 8. Verification

Runbook commands (token from root `.env`, `WRANGLER_R2_SQL_AUTH_TOKEN`):
```bash
cd loader
export WRANGLER_R2_SQL_AUTH_TOKEN="$(grep -E '^WRANGLER_R2_SQL_AUTH_TOKEN=' ../.env | cut -d= -f2- | tr -d '\r')"
npx wrangler r2 sql query <acct>_cboe-options-data "SELECT COUNT(*) n FROM options.ohlc"
npx wrangler r2 sql query <acct>_cboe-options-data "SELECT COUNT(*) n, COUNT(DISTINCT symbol) FROM options.ohlc"
npx wrangler r2 sql query <acct>_cboe-options-data "SELECT COUNT(*) n FROM options.corporate_actions WHERE action_type='SPLIT'"
npx wrangler r2 sql query <acct>_cboe-options-data "SELECT security_id, ticker, valid_from, valid_to FROM options.symbol_history"
# dedupe check: no duplicate (symbol,date) at latest fetched_at
```
- Expected: ~250k `ohlc` rows, ~500 distinct symbols, `>0` split rows if any split occurred
  in the window, `symbol_history` populated for any renames.

---

## 9. Risks / notes

- **Iceberg immutability:** any schema "change" is a table recreate (new sink). We add
  new tables rather than ALTER. Keep `underlyings` publishing until the cutover ships.
- **Folder name:** `load` runs under `lobster-market-pricing` monorepo; all loader work under `loader/`.
- **Yahoo licensing:** personal screener OK; not for commercial redistribution via `/api/query`.
- **Batch vs item scope:** a 2y backfill over 500 symbols on unauth Yahoo will take hours;
  make it item-scoped/resumable, not a single monolithic `ohlc-daily` pass.
- **`adjclose` vs `close`:** realized vol MUST use adjusted closes; store raw OHLC +
  `adjclose` and the raw split events, do not silently overwrite.
- **Ticker renames:** join OHLC to `security_id` through `symbol_history`; never assume
  ticker == identity.
- Verify counts after backfill; account for the existing `verify-1` (`TEST`/`AAPL`) smoke rows.
