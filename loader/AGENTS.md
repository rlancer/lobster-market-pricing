# CBOE Options Loader — Agent Instructions

## Scope

This package (the `loader/` directory of the `lobster-market-pricing` monorepo) loads the 503-symbol S&P 500 manifest from CBOE into Cloudflare Pipelines and R2 Data Catalog tables. The frontend and R2-SQL screener Worker live at the repo root (`frontend/`, `worker/`). The loader itself is a Worker (fetch/normalize/publish in `src/run-symbols.ts`); `tools/load_sp500.py` is a Python driver for one-shot full loads.

## Current verified state

- Scheduler: `EtlScheduler` Durable Object (`src/scheduler.ts`) runs a job
  registry (`src/jobs/registry.ts`) with four jobs — `cboe-options` (item-scoped,
  market-gated, item store `symbol_state`), `ohlc-daily` (batch, daily,
  ungated, whole-universe via `symbols/sp500.json`), `ohlc-backfill`
  (item-scoped, resumable, manual), and `earnings-daily` (batch, daily,
  ungated, ~2-week Nasdaq earnings-calendar window → `options.earnings`).
  Schedule ledger:
  `job_state` (`loader/migrations/0002_job_state.sql`). Job observability and
  manual kicks: `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/trigger`
  (Bearer `LOADER_TOKEN`). `/loop/*` remain cboe-options back-compat aliases
  for the monitor.
- OHLC is live end-to-end: tables `options.ohlc` + `options.realized_vol`
  (created by the sinks), streams `cboe_ohlc_v2` / `cboe_realized_vol_v2`,
  sinks `cboe_ohlc_sink` / `cboe_realized_vol_sink`, pipelines wired. Ingest
  verified in production (records committed → queryable via R2 SQL).
- Manifest: `symbols/sp500.json` — 503 unique symbols.

## Symbol universe (S&P 500 + major ETFs + Nasdaq-100 delta)

The symbol universe is the union of three sources, merged into the single
loader manifest **`symbols/universe.json`** (583 symbols as of 2026-08-09;
same `.symbols` string-array shape as `sp500.json`, plus a `constituents`
symbol→{name, sector, source} map that enriches every symbol):

1. **S&P 500** (`source: "sp500"`) — `symbols/sp500.json` + `symbols/sp500_constituents.json`.
2. **Nasdaq-100 delta** (`source: "nasdaq100"`) — the 15 Nasdaq-100 members not
   already in the S&P 500 (ASML, ARM, MSTR, SHOP, MELI, PDD, RKLB, ALNY, NBIS,
   CCEP, TRI, FER, ALAB, CRWV, SPCX).
3. **Major ETFs** (`source: "etf"`) — the curated `symbols/etfs.json` manifest
   (65 broad-market / sector / international / fixed-income / commodity / real-estate /
   thematic / leveraged ETFs, each verified to have a CBOE option chain).

The Dow Jones 30 is deliberately excluded: every Dow member is already an S&P
500 constituent, so it adds zero symbols. Russell 1000/3000 are excluded per
product scope ("the whole universe" is not wanted).

**Refresh procedure** (reusable, run when index membership changes — ~quarterly
is plenty):

```powershell
python tools/refresh_universe.py --probe-cboe   # fetch NDX live, merge, validate CBOE chains
```

- Fetches Nasdaq-100 constituents live from Nasdaq's official API
  (`https://api.nasdaq.com/api/quote/list-type/nasdaq100`); falls back to a
  pinned copy in the script if the API is unreachable.
- ETF membership only changes by editing `symbols/etfs.json` (no canonical free
  "major ETFs" list exists).
- `--probe-cboe` verifies each new symbol has a CBOE delayed-quotes option chain
  (retries past 429/5xx rate-limiting). A flagged symbol is *advisory* — confirm
  with a single manual request before dropping (see `symbols/etfs.json` note:
  IYM/XRT/IBB/QQQE are genuinely absent from CBOE's free feed).
- Output is deterministic and atomic; the `symbols/` dir is the only thing it writes.

To actually consume the extended universe, the loader jobs (`cboe-options`,
`ohlc-daily`, `ohlc-backfill`, `earnings-daily`) and `run-symbols.ts` enrichment
must import `universe.json` instead of `sp500.json`/`sp500_constituents.json`.
ETFs produce no earnings rows (harmless in `earnings-daily`). `MAX_SYMBOLS` is
enforced per-`runSymbols` *batch* (capped by `LOADER_BATCH_SIZE`), not across the
universe, so larger universes do not trip it. See `PLAN-UNIVERSE.md`.
- Canonical checkpoint: `.sp500-catalog-load-state.json`.
- Latest load: 502 complete symbols; NVR failed with CBOE HTTP 403.
- NVR is intentionally recorded in `symbols/sp500-load-exceptions.json`.
- Latest observed catalog counts included synthetic `ZZZ` smoke-test data; exclude `ZZZ` from S&P counts.
- Pipeline HTTP streams are authenticated (Bearer `PIPELINE_AUTH_TOKEN`) and the
  ingest token was rotated + saved to GitHub (2026-08-08). Treat unauthenticated
  `PIPELINE_*_URL`s as test-only.

## Continuous background loader

Runs via the `EtlScheduler` Durable Object alarm loop
(`src/scheduler.ts`), dispatching registered jobs from `src/jobs/registry.ts`
(`cboe-options` item-scoped, `ohlc-daily` batch, `ohlc-backfill` item-scoped,
`earnings-daily` batch). Key invariants when editing it:

- **Two-level state.** `job_state` (migration `0002`) is the per-job schedule
  ledger (enabled, cadence_seconds, market_gated, next_attempt_after,
  consecutive_failures, backoff_seconds, last_error); item-scoped jobs keep
  per-item progress in their own store (`symbol_state` for cboe-options).
  `seedJobs()` inserts registry rows idempotently; `dueJobs()` scans
  `enabled=1 AND next_attempt_after <= now`, stalest-first. Per-job
  `last_pass` meta lives under `last_pass:{job_id}`; `/loop/status` reads
  `last_pass:cboe-options`.
- **Single-flight.** The loop must never run two refresh passes at once. Alarm
  re-arm happens only in `alarm()`'s `finally`; the `passing` storage flag also
  guards manual `/loop/trigger`. Preserve both. The flag is stored as a numeric
  timestamp; a marker older than `LOADER_RUN_TIMEOUT_SECONDS` + 60s (or a legacy
  boolean) is treated as stale and cleared in `tick()` so a "Durable Object
  reset" mid-pass can never permanently stall the loop.
- **D1 is the source of truth.** Per-symbol progress lives in `symbol_state`
  (`loader/migrations/0001_initial.sql`): `next_attempt_after <= now` = due
  (epoch ms); `consecutive_failures`/`backoff_seconds` drive exponential backoff
  (60s → 5m → 30m capped). Success resets and re-schedules at the cadence.
  Never lose progress on restart — re-seed only when the table is empty.
- **Batch jobs** (`ohlc-daily`) run their whole `universe()` per pass, governed
  by `job_state` cadence (86400s); they touch no item store. Its handler
  short-circuits (dry-run) when neither `PIPELINE_OHLC_URL` nor
  `PIPELINE_REALIZED_VOL_URL` is set — no source fetches, no publishes.
- **The container is retired.** CBOE fetch / OCC normalization / Pipeline
  publication lives in `src/run-symbols.ts` (`runSymbols`), called in-process by
  the DO's `tick()` and by the public `POST /run` handler. No `container/`,
  `Dockerfile`, or `CboeLoaderContainer` binding exists anymore — do not re-add
  them or reference `@cloudflare/containers`.
- **NVR's CBOE 403** is an expected persistent failure — retry with the normal
  backoff; never special-case-crash on it.
- **Secrets.** `LOADER_TOKEN` and `PIPELINE_*_URL`/`PIPELINE_AUTH_TOKEN` stay as
  Wrangler secrets; never log or commit them. `database_id` in `wrangler.jsonc`
  is a placeholder — real D1 id is provisioned via the dashboard/`wrangler d1`.
- **Safety before tuning.** Defaults are modest (`LOADER_BATCH_SIZE=40`,
  `LOADER_CADENCE_SECONDS=900`); tune up only after the full-refresh validation
  passes. A 250-symbol batch OOM'd the DO isolate and timed out in live
  validation — keep the batch small. See README "Safe defaults and tuning".

## Required operating gates

1. Before any full load, send a unique synthetic contract record to the contracts stream and require HTTP 200 with `success: true`.
2. Include `User-Agent: cboe-to-r2/0.2` on Pipeline POSTs. The contract endpoint returned Cloudflare error 1010 without it.
3. Writes go to the real Pipeline endpoints (secrets). There is no `WRITE_MODE=stdout` smoke mode anymore — the loader runs in-process and always publishes.
4. Use `tools/load_sp500.py` with `--batch-size 1`, `--resume`, `--continue-on-failure`, and an explicit state path.
5. Never delete or overwrite a checkpoint to bypass failures. Retry failed groups; completed groups must remain skipped.
6. Treat NVR's HTTP 403 as an expected explicit exception unless the CBOE source changes.
7. Do not claim completion until the checkpoint and R2 SQL both verify the result.

## Pipeline and catalog identifiers

```text
Warehouse: 3315bb3e7d2e3556bfea6fb3947a890e_cboe-options-data
Runs:        <PIPELINE_RUNS_URL secret — see Cloudflare dashboard / wrangler secret>
Contracts:   <PIPELINE_CONTRACTS_URL secret — see Cloudflare dashboard / wrangler secret>
OHLC:        <PIPELINE_OHLC_URL secret — stream cboe_ohlc_v2>
RealizedVol: <PIPELINE_REALIZED_VOL_URL secret — stream cboe_realized_vol_v2>
CorporateActions: <PIPELINE_CORPORATE_ACTIONS_URL secret — stream cboe_corporate_actions_v2>
Securities:  <PIPELINE_SECURITIES_URL secret — stream cboe_securities_v2>
SymbolHistory: <PIPELINE_SYMBOL_HISTORY_URL secret — stream cboe_symbol_history_v2>
UnderlyingSnapshots: <PIPELINE_UNDERLYING_SNAPSHOTS_URL secret — stream cboe_underlying_snapshots_v2>
Earnings:          <PIPELINE_EARNINGS_URL secret — stream cboe_earnings_v2>  # provisioned 2026-08-09
Streams: cboe_option_contracts_v2, cboe_refresh_runs_v2,
         cboe_ohlc_v2, cboe_realized_vol_v2, cboe_corporate_actions_v2,
         cboe_securities_v2, cboe_symbol_history_v2, cboe_underlying_snapshots_v2
Sinks:   cboe_option_contracts_sink, cboe_refresh_runs_sink,
         cboe_ohlc_sink, cboe_realized_vol_sink, cboe_corporate_actions_sink,
         cboe_securities_sink, cboe_symbol_history_sink, cboe_underlying_snapshots_sink
Tables: options.option_contracts, options.refresh_runs,
        options.ohlc, options.realized_vol, options.corporate_actions,
        options.securities, options.symbol_history, options.underlying_snapshots
```

The old `options.underlyings` table / `cboe_underlyings_v*` stream+sink+pipeline
were **retired at cutover** (2026-08-08): the descriptive half now lives in
`options.securities` and the run-history half in `options.underlying_snapshots`
(loader dual-published both during migration; the Worker read path now uses
`underlying_snapshots`).

S&P 500 OHLC backfill (`ohlc-backfill` job, item-scoped with a
`ohlc_backfill_state` D1 item store; trigger `POST /jobs/ohlc-backfill/trigger`):
Yahoo chart v8 with `period1`/`period2` + `events=div,split`; realized vol is
computed off **adjusted** closes; dividends/splits go to `options.corporate_actions`.
`security_id` is a deterministic ticker-derived UUID (`src/symbology.ts`) shared by
securities / symbol_history / corporate_actions / the backfill item store.

Inspect existing infrastructure before changing it (names above):

```powershell
npx wrangler pipelines streams get cboe_option_contracts_v2
npx wrangler pipelines get cboe_option_contracts_pipeline
npx wrangler pipelines sinks get cboe_option_contracts_sink
```

`options.securities` / `options.underlying_snapshots` carry `name` and `sector` enriched from the S&P 500 Wikipedia constituents manifest `symbols/sp500_constituents.json`. CBOE's delayed-quotes endpoint does not return a company name or sector, so the loader merges them from the static manifest at publish time (in `src/run-symbols.ts`); symbols missing from the manifest fall back to `name = symbol`, `sector = 'Unknown'` (denormalized onto each `underlying_snapshots` row).

Recreating an Iceberg table (required because Pipeline stream schemas are immutable — see `references/pipelines/gotchas.md`) requires dropping the old stream + sink, dropping the Iceberg table via the catalog, then recreating the stream + sink with the new schema and running a full reload. Note: **sinks cannot be created for existing catalog tables** (wrangler errors `1012 writing to existing Catalog tables is not yet supported`) — the sink must create the table; do not pre-create it.

## Secrets and token handling

GitHub Actions secrets are the de-facto token store for this project. Every
token created below is stored in **both** its runtime location (Worker secret /
`.env`, both gitignored) **and** GitHub Actions secrets, so nothing is ever
only held on a machine.

| Token / secret | Purpose | Required permission | Runtime location | Also in GitHub? |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `wrangler deploy`, pipelines, D1 | Workers Scripts / D1 / Pipelines | GitHub Actions | yes (source of truth) |
| `CLOUDFLARE_ACCOUNT_ID` | deploy target account | — | GitHub Actions | yes |
| `LOADER_TOKEN` | auth for `POST /run`, `/loop/trigger`, `/jobs/*/trigger` | — (any shared secret) | Worker secret | yes |
| `PIPELINE_AUTH_TOKEN` | **stream HTTP ingest auth** (all `cboe_*_v2` streams) | **Workers Pipelines → Send** | Worker secret | yes |
| `PIPELINE_*_URL` (`RUNS`, `CONTRACTS`, `ERRORS`, `OHLC`, `REALIZED_VOL`, `CORPORATE_ACTIONS`, `SECURITIES`, `SYMBOL_HISTORY`, `UNDERLYING_SNAPSHOTS`) | ingest endpoints; write-capable | — (URL = endpoint) | Worker secrets | no (set once) |
| `R2_DATA_CATALOG_TOKEN` | create/drop catalog tables; `--catalog-token` for r2-data-catalog sinks | R2 Storage Admin R&W + R2 Data Catalog R&W | root `.env` (gitignored) | yes |
| `R2_SQL_TOKEN` / `WRANGLER_R2_SQL_AUTH_TOKEN` | query the lake (R2 SQL) via `wrangler r2 sql query` | R2 SQL Read | root `.env` (gitignored) | yes |

Critical rules:

- **Stream HTTP auth needs the `Workers Pipelines → Send` API-token permission.
  Other tokens do not work**: posting to an authenticated stream with an
  unrelated token (e.g. the R2 Data Catalog token) returns
  `401 {"error":{"code":1014,"message":"You are unauthorized to use this
  Pipeline"}}`. When rotating the ingest auth, create a Cloudflare API token
  with exactly **Workers Pipelines → Send** (Account).
- **Rotating `PIPELINE_AUTH_TOKEN`** (the streams accept any token with the
  Send permission — no stream reconfiguration needed):
  ```powershell
  # 1. create the token in the dashboard (My Profile → API Tokens → Create
  #    Token → Workers Pipelines → Send), paste the value into root .env:
  #    PIPELINE_AUTH_TOKEN=<value>
  # 2. store it in GitHub (the de-facto secrets manager) AND on the Worker:
  gh secret set PIPELINE_AUTH_TOKEN
  cd loader && printf '%s' "$env:PIPELINE_AUTH_TOKEN" | npx wrangler secret put PIPELINE_AUTH_TOKEN
  ```
- **R2 Data Catalog table/sink work** uses `R2_DATA_CATALOG_TOKEN` (must have
  R2 Storage Admin R&W + R2 Data Catalog R&W). `wrangler r2 sql query` is
  **read-only** (DDL like `CREATE TABLE` fails with `40003 only read-only
  queries allowed`) — create catalog tables via the Iceberg REST catalog /
  dashboard or let a Pipeline sink create them.
- **Sinks own their tables.** Never pre-create an Iceberg table that a sink
  will target (error `1012 writing to existing Catalog tables is not yet
  supported`).
- `WRANGLER_R2_SQL_AUTH_TOKEN` is stored in the root `.env` (gitignored; see
  `.env.example` at repo root). `mise.toml` does not automatically load `.env`;
  verify presence without exposing the value:
  ```powershell
  mise exec -- python -c "import os; print('present' if os.getenv('WRANGLER_R2_SQL_AUTH_TOKEN') else 'absent')"
  ```
- Never print a token value, pass one as a command-line argument, or commit a
  `.env` / `.dev.vars`. New tokens ALWAYS get a GitHub Actions secret entry so
  the project never loses a working credential again (this bit us with
  `PIPELINE_AUTH_TOKEN`, which had been set only as a Worker secret).


> Run all commands in this section from the `loader/` directory.

## Local load

Terminal 1 — run the Worker locally (secrets from `loader/.dev.vars`):

```powershell
npx wrangler dev
```

Terminal 2 — drive a one-shot full load against the local `POST /run`:

```powershell
python .\tools\load_sp500.py `
  --url http://127.0.0.1:8787/run `
  --batch-size 1 `
  --resume `
  --continue-on-failure `
  --state .sp500-catalog-load-state.json
```

Monitor the continuous loop with `Invoke-RestMethod http://127.0.0.1:8787/loop/status`.

## Validation

Compile changed Python driver:

```powershell
python -m py_compile tools/load_sp500.py
```

Loader behavior is covered by Vitest (`npx vitest run`); typecheck with `npx tsc --noEmit`. Validate both checkpoint and catalog. At minimum query contract, underlying-snapshot, and OHLC counts, then confirm 503 checkpoint groups with only the documented NVR failure. Smoke-test rows (`TEST`) were removed from the lake via `tools/iceberg_rewrite.py` (see the R2 Data Catalog maintenance section).

## R2 Data Catalog maintenance (row-level cleanup / dedupe)

Tables are append-only; a re-run appends rather than overwrites. To remove rows
(smoke/test data) or collapse a table to its latest-wins view, use Iceberg's row
mutation — **not** `wrangler r2 sql` (read-only) and **not** a schema recreate.

How it works:
- Iceberg v2 row-level **deletes** commit *delete files*: rows vanish logically at
  commit time (R2 SQL and the screener Worker honor them immediately), and the
  bytes are physically reclaimed later by the **hourly, automatic compaction** +
  **snapshot expiration** (which now deletes data files). Both run once the table's
  compaction credential is stored.
- Two writable paths (the catalog is standard Iceberg REST, base
  `https://catalog.cloudflarestorage.com/{ACCOUNT}/{BUCKET}`, warehouse
  `{ACCOUNT}_{BUCKET}`, auth `R2_DATA_CATALOG_TOKEN`):
  - **PySpark `DELETE ... WHERE`** — writes small delete files; best for very large
    tables (documented via the R2 Data Catalog Spark template).
  - **PyIceberg `overwrite()`** — atomic whole-table rewrite in one snapshot. For
    targeted hygiene on smaller tables this is the light path and needs no JVM.

Reusable tool: `tools/iceberg_rewrite.py` (PyIceberg). Requires
`pip install "pyiceberg[pyiceberg-core]" pyarrow pandas` (the core extra is needed
for partition transforms — these tables are partitioned by `day(__ingest_ts)`).

```bash
cd loader
export R2_DATA_CATALOG_TOKEN=...   # R2 Storage Admin R&W + Data Catalog R&W
# Dry-run first, then drop the --dry-run to commit:
python tools/iceberg_rewrite.py ohlc            --exclude symbol=TEST --dry-run
python tools/iceberg_rewrite.py corporate_actions --exclude ticker=PROBE
python tools/iceberg_rewrite.py securities      --dedupe ticker --drop ticker=PROBE
python tools/iceberg_rewrite.py ohlc            --dedupe symbol,date
```

Gotchas:
- `overwrite()` rewrites the **whole** table in one atomic commit; if it fails the
  table is unchanged. Do not run it while that table's Pipeline sink is actively
  ingesting (commit conflicts are surfaced as errors, never silent corruption).
- The pandas (`--dedupe`) path casts output back to the table schema so required
  fields stay required; the pure `--exclude` path keeps the schema as-is.
- This is for **row cleanup, not schema change** — schema changes still mean a
  table recreate (new sink). Never pre-create a sink's table.

## Implementation invariants

- `fetchChain()` in `src/run-symbols.ts` honors `Retry-After` and backoff on CBOE 408/429/5xx; Pipeline POSTs retry on 5xx/network only.
- Pipeline records use the loader User-Agent (`cboe-to-r2/0.2`) and idempotency keys; run/pass state is tracked in D1 (`symbol_state` per item, `job_state` per job, `loader_meta` for `last_pass`/stats) by the EtlScheduler.

Human-facing procedure: `README.md`.
