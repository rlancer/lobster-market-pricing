# CBOE Options to R2

Loader-only pipeline for periodic CBOE options snapshots:

```text
CBOE → Cloudflare Worker (in-process loader) → Cloudflare Pipelines → R2 Data Catalog Iceberg tables → R2 SQL
```

This package is the loader half of the `options-db` monorepo; the frontend, R2-SQL Worker API, and Pages deploy live at the repo root (`frontend/`, `worker/`, `.github/workflows/deploy.yml`). This package itself contains no frontend, browser SQL, Pages, or static Parquet-serving code.

## Current status

The continuous scheduler (`EtlScheduler` + job registry) is live and the OHLC
enrichment path is provisioned + verified end-to-end in production.

Infrastructure:

- Catalog tables: `options.option_contracts`, `options.refresh_runs`,
  **`options.ohlc`, `options.realized_vol`**, and the symbology/decoupled set
  **`options.securities`, `options.symbol_history`,
  `options.underlying_snapshots`, `options.corporate_actions`**. The old
  `options.underlyings` table was **retired** at cutover — descriptive facts
  live in `securities`, run-history snapshots in `underlying_snapshots`.
- Jobs (D1 `job_state` ledger): `cboe-options` (continuous, market-gated, item
  store `symbol_state`), `ohlc-daily` (daily, ungated, whole universe),
  `ohlc-backfill` (item-scoped, resumable via the `ohlc_backfill_state` D1 item
  store; run `POST /jobs/ohlc-backfill/trigger`), and `earnings-daily` (daily,
  ungated; ~2-week Nasdaq earnings-calendar window filtered to the S&P 500
  universe → `options.earnings`)
- Scheduler observability: `GET /jobs`, `GET /jobs/{id}`,
  `POST /jobs/{id}/trigger` (Bearer `LOADER_TOKEN`); `/loop/*` stay as
  cboe-options back-compat aliases for the monitor
- `options.underlying_snapshots` carries `name` and `sector` denormalized per snapshot, enriched from the S&P 500 Wikipedia constituents manifest (`symbols/sp500_constituents.json`), which is bundled with the Worker. CBOE's delayed-quotes endpoint does not return a company name or sector, so the loader merges them from the static manifest at publish time; symbols missing from the manifest fall back to `name = symbol`, `sector = 'Unknown'`. The stable identity (a deterministic ticker-derived `security_id`, `src/symbology.ts`) lives on `securities` / `symbol_history` / `corporate_actions` and lines up across all writers.
- Worker: `cboe-to-r2`
- Deployment: GitHub Actions workflow (auto on push to `main`), including the
  D1 migration step

The Pipeline HTTP streams are authenticated (Bearer, `PIPELINE_AUTH_TOKEN`).
The ingest token was rotated and stored in GitHub (2026-08-08) — the stream
auth requires a Cloudflare API token with the **Workers Pipelines → Send**
permission (other tokens return `401 / code 1014 "unauthorized to use this
Pipeline"`). The Worker `/run`, `/loop/trigger`, and `/jobs/*/trigger` endpoints
are protected by `LOADER_TOKEN`. `PIPELINE_OHLC_URL` /
`PIPELINE_REALIZED_VOL_URL` / `PIPELINE_CORPORATE_ACTIONS_URL` /
`PIPELINE_SECURITIES_URL` / `PIPELINE_SYMBOL_HISTORY_URL` /
`PIPELINE_UNDERLYING_SNAPSHOTS_URL` are set as Worker secrets and ingest into
the corresponding `options.*` tables (verified: committed → queryable via
R2 SQL).

The OHLC source is Yahoo chart v8 (`interval=1d`). The daily job uses
`range=1y`; the `ohlc-backfill` job requests `period1`/`period2` + `events=div,split`.
Realized volatility is computed off **adjusted** closes (split-safe); Yahoo
dividend/split events are persisted to `options.corporate_actions`. `security_id`
(`src/symbology.ts`) is a deterministic ticker-derived UUID shared by
`securities`, `symbol_history`, `corporate_actions`, and the backfill item store.

### Earnings calendar (`earnings-daily`)

Fetches the **Nasdaq earnings calendar** (`api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD`,
keyless, browser-ish `User-Agent`) for today + the next 13 days, filters to the
S&P 500 manifest, and publishes normalized rows to `options.earnings`
(`symbol`, `earnings_date`, `time` in {after-hours, pre-market, null}, `name`,
`fiscal_q`, `eps_forecast`, `est_count`, `last_year_eps`, `source`, `run_id`,
`fetched_at`). The lake is append-only, so consumers keep the newest run per
`(symbol, earnings_date)` with `QUALIFY` — the same latest-wins pattern as OHLC.
Verified live against the real calendar 2026-08-08 (the probe
`tools/earnings_probe.ts` prints per-date calendar vs. S&P 500 row counts).

**Provisioned and live (2026-08-09)** — stream `cboe_earnings_v2`, sink
`cboe_earnings_sink` (created `options.earnings`), pipeline
`cboe_earnings_pipeline` (`INSERT INTO cboe_earnings_sink SELECT * FROM
cboe_earnings_v2`), `PIPELINE_EARNINGS_URL` set as a Worker secret; first
ingestion verified (23 S&P-500 rows → R2 SQL). The `earnings-daily` job
auto-refreshes the ~2-week window daily (ungated). The commands below are the
recipe for any future table (a token with Pipelines write + R2 Data Catalog
write is required; the local OAuth token has both):

```powershell
cd loader
# 1. create stream cboe_earnings_v2 with schemas/earnings.json,
#    sink cboe_earnings_sink (creates options.earnings table),
#    and pipeline cboe_earnings_pipeline (stream → sink)
npx wrangler pipelines stream create cboe_earnings_v2   --schema schemas/earnings.json
npx wrangler pipelines sink create  cboe_earnings_sink  --table options.earnings --bucket ...
# (exact flags per `wrangler pipelines --help`; a token with
#  Workloads/Pipelines write + R2 Data Catalog write is required)
# 2. set the ingest URL as a Worker secret (it may be unauthenticated — same
#    cred-URL model as the other cboe_* streams):
npx wrangler secret put PIPELINE_EARNINGS_URL
# 3. confirm S&P 500 rows land, then trigger a sync:
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/jobs/earnings-daily/trigger -Headers @{ Authorization = "Bearer $env:LOADER_TOKEN" }
```

Once `options.earnings` exists it auto-appears in the Worker's `/api/tables`,
so the AI Copilot can query it (and join it to chains) with no further wiring.

### Econ / FOMC calendar (`fred-econ-daily`)

Fetches the scheduled **high-impact macro releases** (CPI, PPI, Employment
Situation, GDP, Personal Income, Surveys of Consumers) from FRED's release-date
API plus **FOMC/Beige Book** events from the Federal Reserve's keyless calendar
JSON, and publishes normalized rows to `options.econ_calendar` (`event_date`,
`title`, `kind` in {macro, fed}, `source` in {fred, federalreserve},
`event_time` "HH:MM" ET (Fed FOMC/Beige only; null for FRED releases), `run_id`,
`fetched_at`). Batch-scoped, ungated, daily cadence; each pass syncs the window
(~2y back → ~400d forward) one source at a time so a per-source failure is
recorded without aborting the rest — the same isolation model as `earnings-daily`.

Why these two sources: FRED `releases/dates` (plural) ignores `release_id`,
emits daily placeholders for press releases (FOMC), and truncates at 1000 rows,
so the loader calls the singular `/fred/release/dates` per allowlisted
`release_id` with `include_release_dates_with_no_data=true` (real scheduled
dates, historical + forward). FOMC/Beige dates come from the Fed calendar JSON
(2017 → year-end, decision-day dates), which the screener Worker's
`/api/econ_calendar` reads from the lake with a live-fetch fallback. The
historical FOMC rows enable realized binary-event-impact joins against
`options.ohlc`. Verified live 2026-08-10 (`tools/econ_probe.ts` prints per-source
row counts; ~28-29 dates per FRED release, ~59 FOMC/Beige events).

**Provisioned and live (2026-08-10)** — stream `cboe_econ_v2`, sink
`cboe_econ_sink` (created `options.econ_calendar`), pipeline
`cboe_econ_pipeline` (`INSERT INTO cboe_econ_sink SELECT * FROM cboe_econ_v2`),
`PIPELINE_ECON_URL` + `FRED_API_KEY` set as Worker secrets; first ingestion
published directly through the pipeline (230 rows → R2 SQL). The `fred-econ-daily`
job auto-refreshes the window daily (ungated). Provisioning recipe is identical
to the earnings block above with names `cboe_econ_v2` / `cboe_econ_sink` /
`cboe_econ_pipeline` and `schemas/econ_calendar.json`.

### ETF fund profiles + top holdings (`etf-daily`)

Yahoo chart v8 already stores ETF **distributions** on `options.corporate_actions`
(same `events=div,split` path as equities — most of the 73 ETFs have dividend rows;
commodity trusts like GLD/SLV/USO and some VIX ETPs typically pay none). `etf-daily` adds the
facts that path does not carry:

- `options.etf_profiles` — expense ratio, AUM, issuer/family, category, trailing
  yield, inception (one row per ETF per run; latest-wins on `ticker`)
- `options.etf_holdings` — Yahoo's **top-10** book (`rank`, `holding_symbol`,
  `weight`), not the full portfolio. Full N-PORT holdings are a later table.

Source is Yahoo `quoteSummary` modules `fundProfile,topHoldings,summaryDetail,defaultKeyStatistics`,
which needs a crumb+cookie session (chart v8 does not). The job opens one
session per pass and reuses it across `symbols/etfs.json` (73 names, including
the VIX ETP sleeve). Batch,
ungated, daily. Dry-run unless `PIPELINE_ETF_PROFILES_URL` or
`PIPELINE_ETF_HOLDINGS_URL` is set.

### Equity fundamentals (`fundamentals-daily`)

Research detail strips (market cap, trailing/forward P/E, debt, D/E, margins)
used to live-scrape Yahoo `quoteSummary` from the Worker on cache miss.
`fundamentals-daily` lands the same fields in the lake:

- `options.fundamentals` — one row per equity per run (latest-wins on `ticker`):
  `market_cap`, `enterprise_value`, `trailing_pe`, `forward_pe`, `peg_ratio`,
  `price_to_book`, `total_debt`, `debt_to_equity`, `profit_margins`,
  `revenue_growth`, plus `security_id`, `source`, `fetched_at`.

Universe is the equity sleeve of `symbols/universe.json` (S&P 500 + Nasdaq-100
delta — ETFs are excluded; they have no meaningful PE/debt strip). Source is
Yahoo `quoteSummary` modules `summaryDetail,defaultKeyStatistics,financialData`
via the same crumb session helpers as `etf-daily`. Batch, ungated, daily.
Dry-run unless `PIPELINE_FUNDAMENTALS_URL` is set. Provisioning recipe matches
the earnings block with names `cboe_fundamentals_v2` / `cboe_fundamentals_sink` /
`cboe_fundamentals_pipeline` and `schemas/fundamentals.json`.

### Continuous futures OHLC (`futures-ohlc-daily`)

Yahoo chart v8 continuous front-month contracts (`ES=F`, `NQ=F`, `CL=F`, …)
from the curated manifest `symbols/futures.json` (CME/CBOT/NYMEX/COMEX equity
index, energy, metals, rates, FX, crypto). Reuses `publishOhlc` into the
existing `options.ohlc` + `options.realized_vol` pipelines — no new stream.
Batch, ungated, daily. Dry-run unless `PIPELINE_OHLC_URL` or
`PIPELINE_REALIZED_VOL_URL` is set. CFE products (VX, …) are **not** on Yahoo
as `VX=F`; they land via `cfe-futures-daily`.

### CBOE volatility-index OHLC (`indices-ohlc-daily`)

Yahoo chart v8 INDEX symbols (`^VIX`, `^VVIX`, `^VIX9D`, `^VIX3M`, `^SKEW`,
`^VXN`) from the curated manifest `symbols/indices.json`. Reuses `publishOhlc`
into `options.ohlc` + `options.realized_vol` — no new stream. Batch, ungated,
daily. Dry-run unless `PIPELINE_OHLC_URL` or `PIPELINE_REALIZED_VOL_URL` is set.
These are **not** part of the equity/ETF option-chain universe (VIX index options
use a different CBOE root). Cash VIX delayed quotes also exist at
`cdn.cboe.com/.../quotes/_VIX.json`; daily spot history comes from Yahoo.
VX futures term structure is `cfe-futures-daily`.

### Cboe Futures Exchange settlements + quotes (`cfe-futures-daily`)

CFE term structure for the options lake (VX curve and sibling products):

- `options.futures_settlements` — official daily settlement CSV
  (`Product`, `Symbol`, `Expiration Date`, `Price`) including weeklies
- `options.futures_quotes` — delayed monthals from
  `cdn.cboe.com/.../quotes/{ROOT}{M}{YY}.json` (e.g. `VXU26`), derived from
  monthly settlement rows (`VX/U6` → `VXU26`). Weeklies that 403 are skipped.

Sources are keyless CBOE public surfaces (same family as equity delayed
quotes). Batch, ungated, daily; passes are `settlements` + `quotes` so a
per-pass failure is isolated. Dry-run unless
`PIPELINE_FUTURES_SETTLEMENTS_URL` or `PIPELINE_FUTURES_QUOTES_URL` is set.
Provisioning recipe matches the earnings block with names
`cboe_futures_settlements_v2` / `cboe_futures_settlements_sink` /
`cboe_futures_settlements_pipeline` (`schemas/futures_settlements.json`) and
`cboe_futures_quotes_v2` / `cboe_futures_quotes_sink` /
`cboe_futures_quotes_pipeline` (`schemas/futures_quotes.json`).

### Research brief warm (`research-briefs-daily`)

After lake OHLC / fundamentals / ETF jobs land, this item-scoped daily job
warms the API Worker's D1 `ticker_research` cache so `/research/{ticker}` is a
D1 hit for first visitors (no new Iceberg table — the brief is already a D1
JSON blob). Each due batch POSTs to `POST {RESEARCH_API_BASE}/api/research/warm`
with `Bearer ADMIN_TOKEN` (same secret as the Worker admin endpoints). Item
store: `research_brief_state` (migration `0004`). Dry-run unless both
`RESEARCH_API_BASE` and `ADMIN_TOKEN` are set. Manual kick:

```bash
curl -s -X POST -H "Authorization: Bearer $LOADER_TOKEN" \
  'https://cboe-to-r2.robertlancer.workers.dev/jobs/research-briefs-daily/trigger'
```

## Package layout

- `src/run-symbols.ts` — CBOE fetch, OCC normalization, batching, retries, and Pipeline publication (in-process, no container)
- `src/ohlc.ts` — Yahoo OHLC + realized-vol + corporate-actions fetch/normalize/publish (period1/period2 windows, adjclose-based realized vol)
- `src/futures.ts` — CFE settlement CSV + delayed monthals fetch/normalize/publish
- `src/symbology.ts` — deterministic ticker-derived `security_id` (shared by securities / symbol_history / corporate_actions / backfill)
- `tools/figi_map.ts` — OpenFIGI mapper for `symbols/universe.json` → `options.securities` + `options.symbol_history`
- `src/index.js` — Worker endpoint, one-shot `/run` + `/loop/*` + `/jobs*` driver routing
- `src/scheduler.ts` — the generic `EtlScheduler` Durable Object (job-agnostic alarm loop + `/jobs` observability)
- `src/jobs/` — job registry (`registry.ts`) + adapters (`cboe-options.ts`, `ohlc-daily.ts`, `ohlc-backfill.ts`, `earnings-daily.ts`, `etf-daily.ts`, `fundamentals-daily.ts`, `futures-ohlc-daily.ts`, `cfe-futures-daily.ts`, `indices-ohlc-daily.ts`, `research-briefs-daily.ts`)
- `src/earnings.ts` — Nasdaq earnings-calendar fetch/normalize/publish
- `src/etf.ts` — Yahoo fundProfile + topHoldings fetch/normalize/publish
- `src/fundamentals.ts` — Yahoo equity quoteSummary fundamentals fetch/normalize/publish
- `migrations/0001_initial.sql` — D1 schema (`symbol_state`, `loader_meta`)
- `migrations/0002_job_state.sql` — D1 schedule ledger (`job_state`)
- `migrations/0003_ohlc_backfill_state.sql` — D1 backfill item store (`ohlc_backfill_state`)
- `schemas/` — Pipeline input schemas (`option_contracts`, `underlyings`, `refresh_runs`, `ohlc`, `realized_vol`, `securities`, `symbol_history`, `underlying_snapshots`, `corporate_actions`, `earnings`, `fundamentals`, …)
- `wrangler.jsonc` — Worker, D1, DO (`ETL_SCHEDULER`), and Pipeline endpoint configuration
- `.github/workflows/deploy-loader.yml` — Worker deployment (auto on push to `main`, incl. D1 migrations)
- `../FOLLOW-UP-ACTIONS.md` — full-dataset population procedure

## Continuous background loader

Replaces the one-shot/scheduled refresh with a **self-sustaining loop that never
stops**. No cron, no schedule.

### How it works

A single Durable Object instance (`EtlScheduler`) runs a self-rescheduling
**alarm loop**. Each alarm pass:

1. Seeds `symbol_state` from `symbols/sp500.json` on first run (every symbol,
   `enabled=1`, due immediately).
2. Picks the due batch: `WHERE enabled = 1 AND next_attempt_after <= now`
   ordered by `priority` then stalest-first (`last_success_at`), `LIMIT` the
   batch size.
3. Runs the ported loader in-process for that batch — `runSymbols(batch, env)`
   fetches each symbol from CBOE, normalizes it, and publishes to Pipeline with
   the same retry/idempotency behavior the container used, but no external hop.
4. Updates D1 per symbol: **success** resets failures and reschedules the next
   reload at the cadence; **failure** increments `consecutive_failures`, doubles
   `backoff_seconds` from 60s → 5m → 30m (capped), and sets `next_attempt_after`
   accordingly. NVR's persistent CBOE 403 is just a failed symbol — it retries
   with the normal backoff, no special-casing.
5. Re-arms the alarm, so the cycle repeats indefinitely.

### Why a Durable Object alarm loop

- **Cheapest on the free tier.** Each pass is one small indexed D1 read, the
  CBOE fetches → Pipeline/R2 writes, and a handful of D1 writes. The I/O is
  network-bound and runs in-process (bounded concurrency), so CPU cost is
  negligible and grows only with refresh volume. A Workflow would bill every
  `step.do`/`step.sleep` in an infinite loop for no benefit here.
- **Durable across restarts.** Alarm state is stored durably, and D1 holds
  per-symbol progress, so nothing is lost on redeploy.
- **Single-flight for free.** A DO runs one `alarm()` at a time; the next alarm
  is armed only after the pass returns. A `passing` storage flag additionally
  guards manual `/loop/trigger` against an in-flight pass, so overlapping runs
  and duplicate run publication are impossible.

### Bootstrap

The loop arms itself: the first request to the Worker (any of `/run`, `/status`,
`/health`, or a `/loop/*` route) arms the driver via `ctx.waitUntil(ensureArmed())`
— one alarm schedules the next forever. Set `CONTINUOUS_LOADER_ENABLED=false`
to disable the loop entirely.

**Self-healing re-arm.** `fetch()` calls `ensureArmed()` on *every* request,
including the read-only `/loop/status` and `/loop/symbols` that the monitor
polls every ~20s. Without this, a DO reset/deploy (e.g. `"Durable Object reset
because its code was updated"`) consumes the in-flight alarm and, if the DO is
destroyed mid-pass, the `alarm()` `finally` re-arm never runs — the loop would
otherwise stay stranded with no alarm and burn an entire session. Re-arming on
every poll makes the loop durable across redeploys.

### One-time setup

Create the D1 database and point the binding at it (the committed
`database_id` is a placeholder):

```powershell
cd loader
npx wrangler d1 create cboe-loader-state   # copy the returned id
# paste that id into wrangler.jsonc `d1_databases[0].database_id`,
# then `npx wrangler d1 migrations apply cboe-loader-state`
```

Migrations in `migrations/` are also applied automatically on deploy.

### Observability

- `GET /loop/status` — counts (total / enabled / due / failing), the last pass
  summary (`last_pass`), the next alarm time, whether a pass is in flight, and
  `market` (open / reason / `now_et` / `next_open_et`). Read-only; safe to
  expose to the consumer.
- `GET /loop/symbols?filter=&q=&limit=&offset=&sort=&order=` — paginated,
  read-only per-symbol listing of `symbol_state`. Read-only; never writes to
  D1. `filter` ∈ `all|enabled|disabled|failing|retrying|due|stale` (default
  `all`); `q` is a symbol-substring `LIKE`; `limit` defaults 100 (max 1000),
  `offset` for paging; `sort` ∈ `symbol|last_success_at|consecutive_failures`
  with `order` ∈ `asc|desc` (default `asc`). Returns
  `{ ok, filter, total, items:[{ symbol, enabled, last_success_at,
  last_attempt_at, consecutive_failures, next_attempt_after, backoff_seconds,
  last_error }] }` (epoch-ms timestamps; `null` when never recorded).
- `POST /loop/trigger` (Bearer `LOADER_TOKEN`) — run one pass now (still
  serialized against the alarm).
- Job-aware observability (the monitor's eventual home; `/loop/*` are
  cboe-options aliases):
  - `GET /jobs` — list every registered job + its `job_state` ledger, scope,
    policy, and `last_pass`.
  - `GET /jobs/{id}` — one job's status (e.g. `/jobs/cboe-options`,
    `/jobs/ohlc-daily`).
  - `POST /jobs/{id}/trigger` (Bearer `LOADER_TOKEN`) — run that job's pass
    now regardless of cadence.
- Each pass logs a single newline-delimited JSON `pass_completed` event
  (`attempted`, `succeeded`, `failed`, `run_id`, `error`).

### Safe defaults and tuning

CBOE data refreshes ~every 15 min intraday. All are `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `LOADER_BATCH_SIZE` | 40 | symbols per `/run` pass (bounds pass duration + per-cycle writes) |
| `LOADER_POLL_INTERVAL_SECONDS` | 60 | seconds between passes |
| `LOADER_CADENCE_SECONDS` | 900 | reload every ~15 min after a success |
| `LOADER_BACKOFF_BASE_SECONDS` | 60 | first failure backoff |
| `LOADER_BACKOFF_CAP_SECONDS` | 1800 | max backoff (30 min) |
| `LOADER_RUN_TIMEOUT_SECONDS` | 600 | safety net for a stuck pass; the batch backs off and retries |
| `SYMBOL_CONCURRENCY` | 8 | symbols fetched/normalized in parallel per pass (runSymbols) |
| `MARKET_HOURS_ENABLED` | true | skip passes + sleep until open when the US regular session is closed |
| `MARKET_OPEN_MINUTES` | 570 (09:30 ET) | market open, minutes-since-midnight ET |
| `MARKET_CLOSE_MINUTES` | 960 (16:00 ET) | market close, minutes-since-midnight ET |
| `MARKET_EARLY_CLOSE_MINUTES` | 780 (13:00 ET) | early-close time (Christmas Eve, Black Friday) |

`LOADER_BATCH_SIZE` is kept modest (40). Per-symbol publication is serialized
through a single publish chain to guarantee deterministic output, so a large
batch stretches the pass and buffers thousands of parsed contracts in the DO
isolate at once — live validation at batch 250 OOM'd the DO isolate and hit the
600s `LOADER_RUN_TIMEOUT_SECONDS`. At 40 a pass completes well inside the
timeout (and each drained symbol's records are freed immediately, bounding
memory). The serialized-publish throughput constraint means refreshing the
full 503-symbol universe takes longer than the 15-min cadence, so a symbol can
age up to ~20–25 min between refreshes. Revisit `LOADER_BATCH_SIZE` /
publication concurrency only after re-validating the full-refresh cycle on a
live market day.

**Concurrency (`src/run-symbols.ts`).** Per-symbol work is I/O-bound (CBOE fetch
+ Pipeline POSTs), so `SYMBOL_CONCURRENCY` worker tasks (a promise semaphore)
overlap it near-linearly with no thread/GIL artifact — a 24-symbol fixture runs
at ~4–8× wall-clock as C scales. Contract batches are flushed with unique
idempotency keys, and publication is serialized in symbol-input order.
Verified: an 8-symbol fixture with stubbed CBOE/Pipeline produces byte-identical
pipeline output at C=1 and C=8 (same contracts, underlying snapshots, run/error records).

Outside regular US market hours (weekends, US holidays, overnight/after-hours)
there is no new CBOE data, so the loop sleeps one far-out alarm until the next
open and skips passes entirely — no container waking, no Pipeline/R2 writes.
Set `MARKET_HOURS_ENABLED=false` to always run (e.g. for backfills). Note the
monitor surfaces a symbol as "stale" only during a live session; while the
market is closed a loaded symbol reads "Fresh" (it cannot be refreshed until
the open).


### Local dry-run note

`wrangler deploy --dry-run` validates config + bundle (the DO, D1 binding,
vars). There is no container image step anymore — the whole loader is plain
Worker code, so the dry-run passes fully offline.



## Deployment

Deployment is pure Worker code — `npx wrangler deploy` (automatic on push to
`main` via GitHub Actions). No Docker/container image is built.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — Worker deployment permissions
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
- `LOADER_TOKEN` — protected `/run` + `/loop/trigger` + `/jobs/*/trigger` endpoint token
- `PIPELINE_AUTH_TOKEN` — stream HTTP-ingest auth (Workers Pipelines → Send)
- `R2_DATA_CATALOG_TOKEN` — R2 Data Catalog table/sink management

GitHub Actions secrets are the project's de-facto secrets manager: any token
created (ingest auth, catalog, etc.) is saved there as well as its runtime
location so a credential can never be lost again. See the "Tokens and secrets"
section.

Run **Deploy loader (Worker)** manually from GitHub Actions. Do not add a schedule until the full-refresh validation is complete.

## Tokens and secrets

GitHub Actions secrets are the de-facto token store: every token is saved both
where the runtime needs it and in GitHub, so a credential is never only held on
one machine (see `AGENTS.md` → "Secrets and token handling" for the full
inventory). At a glance:

| Secret | Purpose | Where it lives |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | deploy, pipelines, D1 | GitHub |
| `LOADER_TOKEN` | auth for `/run`, `/loop/trigger`, `/jobs/*/trigger` | Worker secret + GitHub |
| `PIPELINE_AUTH_TOKEN` | stream HTTP-ingest auth — needs **Workers Pipelines → Send** | Worker secret + GitHub |
| `PIPELINE_*_URL` | ingest endpoints (incl. `PIPELINE_OHLC_URL`, `PIPELINE_REALIZED_VOL_URL`) | Worker secrets |
| `R2_DATA_CATALOG_TOKEN` | catalog tables + `--catalog-token` for sinks — needs R2 Storage Admin R&W + R2 Data Catalog R&W | root `.env` + GitHub |
| `R2_SQL_TOKEN` / `WRANGLER_R2_SQL_AUTH_TOKEN` | read-only lake queries (`wrangler r2 sql query`) | root `.env` |

Rules that saved us:

- **Stream ingest auth is a distinct permission.** An unrelated Cloudflare API
  token (even R2 Admin RW) is rejected by authenticated streams with
  `401 code 1014 "unauthorized to use this Pipeline"` — create the ingest token
  with exactly **Workers Pipelines → Send**.
- **Rotating the ingest token** needs no stream changes (streams accept any
  token with the Send permission): create the token, put the value in root
  `.env` as `PIPELINE_AUTH_TOKEN`, then
  `gh secret set PIPELINE_AUTH_TOKEN` and
  `printf '%s' "$env:PIPELINE_AUTH_TOKEN" | npx wrangler secret put PIPELINE_AUTH_TOKEN`.
- `wrangler r2 sql query` is **read-only** (`CREATE TABLE` fails with `40003
  only read-only queries allowed`); create catalog tables via the Iceberg REST
  catalog/dashboard, or let a Pipeline sink create them (sinks error with
  `1012` if the table already exists — never pre-create a sink's table).
- Never print a token, pass one as a CLI argument, or commit `.env` /
  `.dev.vars`.

## Running an S&P 500 refresh

`symbols/sp500.json` contains the 503 current S&P 500 component stocks (including multiple share classes), normalized for the CBOE endpoint. The list is explicit, deduplicated, and retained in this package rather than generated by the Worker.

Validate the request before sending it:

```powershell
$body = Get-Content .\symbols\sp500.json -Raw
$payload = $body | ConvertFrom-Json
if ($payload.symbols.Count -ne 503) { throw "Expected 503 symbols" }
if (($payload.symbols | Sort-Object -Unique).Count -ne 503) { throw "Symbols must be unique" }
```

Call the protected Worker with the complete list:

```powershell
$headers = @{
  Authorization = "Bearer $env:LOADER_TOKEN"
  "Content-Type" = "application/json"
}

Invoke-RestMethod `
  -Method Post `
  -Uri "https://cboe-to-r2.robertlancer.workers.dev/run" `
  -Headers $headers `
  -Body $body
```

The response must contain a `run_id`; do not start another refresh until this run has been validated in R2 SQL. A failed run returns HTTP 502 and must not be treated as the active dataset.

For the initial full load, keep the refresh unscheduled and validate each run
in R2 SQL before proceeding. See [`FOLLOW-UP-ACTIONS.md`](../FOLLOW-UP-ACTIONS.md)
for failure testing and completeness checks.

A one-shot `POST /run` returns the full `{ run, failures }` result directly (HTTP
200 when the run completed, 502 if any symbol failed). For ongoing visibility of
the continuous loop, query the Durable Object:

```powershell
Invoke-RestMethod `
  -Uri "https://cboe-to-r2.robertlancer.workers.dev/loop/status"
```

`/loop/status` reports counts, the `last_pass` summary (`run_id`, attempted /
succeeded / failed, `duration_ms`), next alarm, and market state. Each pass also
logs a newline-delimited JSON `pass_completed` event.


> Run all local commands from the `loader/` directory.

For the robust local strategy, start the Worker locally in one terminal (Pipeline
URLs/token come from `loader/.dev.vars` or `wrangler secret put`):

```powershell
npx wrangler dev
```

Then run the symbol-resumable driver in a second terminal:

```powershell
python .\tools\load_sp500.py `
  --url http://127.0.0.1:8787/run `
  --batch-size 1 `
  --continue-on-failure `
  --state .sp500-catalog-load-state.json
```
Known load exceptions are recorded in [`symbols/sp500-load-exceptions.json`](symbols/sp500-load-exceptions.json). `NVR` is currently listed there because the configured CBOE endpoint returns HTTP 403.

`options.symbol_load_errors` uses [`schemas/symbol_load_errors.json`](schemas/symbol_load_errors.json). Set `PIPELINE_ERRORS_URL` to the authenticated Pipeline endpoint backed by that table before enabling catalog error publication; an empty value intentionally leaves the new stream disabled until the Pipeline and Iceberg table are provisioned.

The default checkpoint is `.sp500-symbol-load-state.json`. It is written atomically after every symbol, so an interrupted run resumes at the next unfinished symbol. A symbol run has its own `run_id`; query those complete run IDs together. Symbols that return persistent upstream errors, such as the observed CBOE 403 for `NVR`, remain recorded for explicit review.

### Full-load preflight and recovery

Do not start a full manifest load until the contract Pipeline passes a synthetic smoke request. The request must include the same `User-Agent` used by `src/run-symbols.ts` (`cboe-to-r2/0.2`); without it, the ingest endpoint can return Cloudflare error 1010 even for a valid record.

```powershell
$probe = '{"symbol":"ZZZ","expiration":"2099-01-01","type":"call","strike":1.0,"run_id":"probe-<unique-id>","as_of_date":"2099-01-01","fetched_at":"2099-01-01T00:00:00+00:00"}'
Invoke-WebRequest `
  -Method Post `
  -Uri $env:PIPELINE_CONTRACTS_URL `
  -Headers @{ 'User-Agent' = 'cboe-to-r2/0.2' } `
  -ContentType 'application/json' `
  -Body "[$probe]"
```

Require HTTP 200 and `{"success":true}` before continuing. Then **delete the
probe from the lake** so it never shows up as market data (do not leave it in
place and filter it in the Worker):

```powershell
python tools/iceberg_rewrite.py option_contracts --delete symbol=ZZZ
```

For local R2 SQL, verify whether the token is present without printing it:

```powershell
mise exec -- python -c "import os; print('present' if os.getenv('WRANGLER_R2_SQL_AUTH_TOKEN') else 'absent')"
```

The monorepo's `mise.toml` (at repo root) does not automatically load `.env`; provide `WRANGLER_R2_SQL_AUTH_TOKEN` through the local secret-loading mechanism before running `wrangler r2 sql query`. Never print or pass the token as a command argument.

Run the resumable loader with one-symbol groups and an explicit checkpoint:

```powershell
python .\tools\load_sp500.py `
  --url http://127.0.0.1:8787/run `
  --batch-size 1 `
  --resume `
  --continue-on-failure `
  --state .sp500-catalog-load-state.json
```

The state file is atomically updated after every symbol. Rerun with `--resume` after correcting a failure; completed groups are skipped and failed groups are retried. Treat `NVR` as an expected exception while the CBOE endpoint continues returning HTTP 403. Do not claim completion from process exit status alone.

Final validation must query R2 SQL and the checkpoint:

```sql
SELECT COUNT(*) AS contracts,
       COUNT(DISTINCT symbol) AS symbols
FROM options.option_contracts;

SELECT COUNT(*) AS underlying_snapshots,
       COUNT(DISTINCT ticker) AS symbols
FROM options.underlying_snapshots;
```

Confirm the checkpoint has 503 groups, 502 complete symbols, and only the documented NVR failure (or explicitly explain any changed exceptions). Confirm every successful symbol has contract and underlying-snapshot rows before treating the refresh as complete.

## Query validation

```sql
SELECT run_id, status, expected_symbols, successful_symbols,
       failed_symbols, contract_count, completed_at
FROM options.refresh_runs
ORDER BY started_at DESC
LIMIT 10;
```

See [`FOLLOW-UP-ACTIONS.md`](../FOLLOW-UP-ACTIONS.md) for the staged full-dataset procedure and production hardening checklist.

## Data maintenance (row cleanup / dedupe)

Tables are append-only; to purge rows (e.g. smoke/test data) or collapse a table
to its latest-wins view, use Iceberg row mutations — `wrangler r2 sql` is
read-only and a recreate is only for schema changes. Provide
[`tools/iceberg_rewrite.py`](tools/iceberg_rewrite.py) (PyIceberg): row-level
`--delete COL=VAL` for large tables (`python tools/iceberg_rewrite.py
option_contracts --delete symbol=ZZZ --dry-run`), or `--exclude`/`--dedupe`
overwrite for small tables. See [AGENTS.md](AGENTS.md) → *R2 Data Catalog
maintenance* for the mechanism and gotchas.

## Security

Never commit API tokens, Worker secrets, `.env` files, or local `.dev.vars` files. R2 Data Catalog and R2 SQL are beta products; retain a recoverable copy until multiple complete refresh cycles have been validated.
