# CBOE Options to R2

Loader-only pipeline for periodic CBOE options snapshots:

```text
CBOE → Cloudflare Worker Container → Cloudflare Pipelines → R2 Data Catalog Iceberg tables → R2 SQL
```

This package is the loader half of the `options-db` monorepo; the frontend, R2-SQL Worker API, and Pages deploy live at the repo root (`frontend/`, `worker/`, `.github/workflows/deploy.yml`). This package itself contains no frontend, browser SQL, Pages, or static Parquet-serving code.

## Current status

The one-symbol AAPL smoke test completed successfully and wrote normalized option contracts to the `options` catalog namespace.

Infrastructure:

- Catalog tables currently in use: `options.option_contracts`, `options.underlyings`, `options.refresh_runs`; planned error table: `options.symbol_load_errors`
- `options.underlyings` carries `name` and `sector` enriched from the S&P 500 Wikipedia constituents manifest (`symbols/sp500_constituents.json`), which is baked into the container image. CBOE's delayed-quotes endpoint does not return a company name or sector, so the loader merges them from the static manifest at publish time; symbols missing from the manifest fall back to `name = symbol`, `sector = 'Unknown'`.
- Worker: `cboe-to-r2`
- Deployment: manual GitHub Actions workflow

The Pipeline HTTP streams are authenticated (Bearer, `PIPELINE_AUTH_TOKEN`)
after the 2026-08-06 security fix — the ingest URLs are rotated and held only
as Wrangler secrets. The Worker `/run` endpoint is protected by `LOADER_TOKEN`.
The continuous loader (see below) is the intended replacement for the
previously manual/scheduled refresh pattern.

## Package layout

- `container/loader.py` — CBOE fetch, OCC normalization, batching, retries, and refresh publication
- `src/index.js` — Worker endpoint, Container routing, and `/loop/*` driver routing
- `src/continuous-loader.js` — the `CboeContinuousLoader` Durable Object (the continuous background driver)
- `migrations/0001_initial.sql` — D1 schema (`symbol_state`, `loader_meta`)
- `schemas/` — Pipeline input schemas
- `wrangler.jsonc` — Worker, Container, D1, DO, and Pipeline endpoint configuration
- `.github/workflows/deploy-loader.yml` — container deployment (auto on push to `main`)
- `../FOLLOW-UP-ACTIONS.md` — full-dataset population procedure

## Continuous background loader

Replaces the one-shot/scheduled refresh with a **self-sustaining loop that never
stops**. No cron, no schedule.

### How it works

A single Durable Object instance (`CboeContinuousLoader`) runs a self-rescheduling
**alarm loop**. Each alarm pass:

1. Seeds `symbol_state` from `symbols/sp500.json` on first run (every symbol,
   `enabled=1`, due immediately).
2. Picks the due batch: `WHERE enabled = 1 AND next_attempt_after <= now`
   ordered by `priority` then stalest-first (`last_success_at`), `LIMIT` the
   batch size.
3. Calls the existing container `/run` with that batch, reusing the same
   authenticated pipeline-headers as the public endpoint — the CBOE fetch,
   normalization, and Iceberg publication logic in `container/loader.py` is
   untouched.
4. Updates D1 per symbol: **success** resets failures and reschedules the next
   reload at the cadence; **failure** increments `consecutive_failures`, doubles
   `backoff_seconds` from 60s → 5m → 30m (capped), and sets `next_attempt_after`
   accordingly. NVR's persistent CBOE 403 is just a failed symbol — it retries
   with the normal backoff, no special-casing.
5. Re-arms the alarm, so the cycle repeats indefinitely.

### Why a Durable Object alarm loop

- **Cheapest on the free tier.** Each pass is one small indexed D1 read, one
  container HTTP call, and a handful of D1 writes — negligible CPU. The real
  spend (CBOE fetches → Pipeline/R2 writes) lives in the container and grows
  only with refresh volume. A Workflow would bill every `step.do`/`step.sleep`
  in an infinite loop for no benefit here.
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
  expose to the consumer without waking the container.
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
- Each pass logs a single newline-delimited JSON `pass_completed` event
  (`attempted`, `succeeded`, `failed`, `run_id`, `error`).

### Safe defaults and tuning

CBOE data refreshes ~every 15 min intraday. All are `vars` in `wrangler.jsonc`:

| Var | Default | Meaning |
|---|---|---|
| `LOADER_BATCH_SIZE` | 250 | symbols per `/run` pass (bounds pass duration + per-cycle writes) |
| `LOADER_POLL_INTERVAL_SECONDS` | 60 | seconds between passes |
| `LOADER_CADENCE_SECONDS` | 900 | reload every ~15 min after a success |
| `LOADER_BACKOFF_BASE_SECONDS` | 60 | first failure backoff |
| `LOADER_BACKOFF_CAP_SECONDS` | 1800 | max backoff (30 min) |
| `LOADER_RUN_TIMEOUT_SECONDS` | 600 | abort a stuck container `/run`; that batch is backed off and retried |
| `SYMBOL_CONCURRENCY` (container ENV) | 8 | symbols fetched/normalized in parallel per `/run` |
| `MARKET_HOURS_ENABLED` | true | skip passes + sleep until open when the US regular session is closed |
| `MARKET_OPEN_MINUTES` | 570 (09:30 ET) | market open, minutes-since-midnight ET |
| `MARKET_CLOSE_MINUTES` | 960 (16:00 ET) | market close, minutes-since-midnight ET |
| `MARKET_EARLY_CLOSE_MINUTES` | 780 (13:00 ET) | early-close time (Christmas Eve, Black Friday) |

`LOADER_BATCH_SIZE` was raised from 10 to 250 to fit the concurrent pass: at
`SYMBOL_CONCURRENCY=8` (~4.3s/symbol serial-equivalent) a 250-symbol batch is
~2 min, two passes cover the universe in ~5 min — inside the 15-min cadence.
Kept just under the 503 so a single stuck symbol can't hold the whole run for
the full timeout; `LOADER_RUN_TIMEOUT_SECONDS` was raised to 600 to fit it.

**Concurrency (container `container/loader.py`).** Per-symbol work is I/O-bound
(CBOE fetch + Pipeline POSTs), so `SYMBOL_CONCURRENCY` `ThreadPoolExecutor`
workers overlap it near-linearly — the GIL is released during socket I/O, so a
24-symbol fixture runs at ~4.0× (C=4) and ~7.9× (C=8) wall-clock, i.e. the
~36-min serial full pass drops to ~4.5 min. Shared state (contract buffer,
batch counter, success/failure tallies) is guarded by a lock; full contract
batches are flushed out-of-lock with unique idempotency keys. Verified: an
8-symbol fixture with stubbed CBOE/Pipeline produces byte-identical pipeline
output at C=1 and C=8 (same contracts, underlyings, run/error records).

Outside regular US market hours (weekends, US holidays, overnight/after-hours)
there is no new CBOE data, so the loop sleeps one far-out alarm until the next
open and skips passes entirely — no container waking, no Pipeline/R2 writes.
Set `MARKET_HOURS_ENABLED=false` to always run (e.g. for backfills). Note the
monitor surfaces a symbol as "stale" only during a live session; while the
market is closed a loaded symbol reads "Fresh" (it cannot be refreshed until
the open).


### Local dry-run note

`wrangler deploy --dry-run` validates config + bundle (both DOs, D1 binding,
vars). The **Docker image build step fails locally** when Docker/Podman is
unavailable — that is expected. Use `--containers-rollout=none` to dry-run the
config/bundle alone; the container image builds on the GitHub-hosted runner.



## Deployment

The deployment workflow uses a GitHub-hosted runner, so Docker Desktop is not required locally.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — Worker and Container deployment permissions
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
- `LOADER_TOKEN` — protected `/run` endpoint token

Run **Deploy loader (Worker + container)** manually from GitHub Actions. Do not add a schedule until the full-refresh validation is complete.

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

Inspect live progress while a refresh is running:

```powershell
Invoke-RestMethod `
  -Uri "https://cboe-to-r2.robertlancer.workers.dev/status"
```

The response reports `run_id`, current symbol, completed/failed symbols, normalized contract count, batch number, last event, and the latest error. Container logs emit the same events as newline-delimited JSON.


> Run all local commands from the `loader/` directory.

For the robust local strategy, start the raw Python loader in one terminal:

```powershell
$env:WRITE_MODE = "pipeline"
# Ingest URLs are unauthenticated write endpoints — never commit them.
# Deploy as Wrangler secrets (`wrangler secret put`); for local container
# dev, source them from .dev.vars (see .dev.vars.example).
# $env:PIPELINE_RUNS_URL       = "<rotated-url>"
# $env:PIPELINE_CONTRACTS_URL  = "<rotated-url>"
# $env:PIPELINE_UNDERLYINGS_URL = "<rotated-url>"
python .\container\loader.py
```

Then run the symbol-resumable driver in a second terminal:


```powershell
python .\tools\load_sp500.py `
  --url http://127.0.0.1:8080/run `
  --batch-size 1 `
  --continue-on-failure `
  --pipeline-runs-url $env:PIPELINE_RUNS_URL `
  --pipeline-contracts-url $env:PIPELINE_CONTRACTS_URL `
  --pipeline-underlyings-url $env:PIPELINE_UNDERLYINGS_URL
```
Known load exceptions are recorded in [`symbols/sp500-load-exceptions.json`](symbols/sp500-load-exceptions.json). `NVR` is currently listed there because the configured CBOE endpoint returns HTTP 403.

`options.symbol_load_errors` uses [`schemas/symbol_load_errors.json`](schemas/symbol_load_errors.json). Set `PIPELINE_ERRORS_URL` to the authenticated Pipeline endpoint backed by that table before enabling catalog error publication; an empty value intentionally leaves the new stream disabled until the Pipeline and Iceberg table are provisioned.

The default checkpoint is `.sp500-symbol-load-state.json`. It is written atomically after every symbol, so an interrupted run resumes at the next unfinished symbol. A symbol run has its own `run_id`; query those complete run IDs together. Symbols that return persistent upstream errors, such as the observed CBOE 403 for `NVR`, remain recorded for explicit review.

### Full-load preflight and recovery

Do not start a full manifest load until the contract Pipeline passes a synthetic smoke request. The request must include the same `User-Agent` used by `container/loader.py`; without it, the ingest endpoint can return Cloudflare error 1010 even for a valid record.

```powershell
$probe = '{"symbol":"ZZZ","expiration":"2099-01-01","type":"call","strike":1.0,"run_id":"probe-<unique-id>","as_of_date":"2099-01-01","fetched_at":"2099-01-01T00:00:00+00:00"}'
Invoke-WebRequest `
  -Method Post `
  -Uri $env:PIPELINE_CONTRACTS_URL `
  -Headers @{ 'User-Agent' = 'cboe-to-r2/0.2' } `
  -ContentType 'application/json' `
  -Body "[$probe]"
```

Require HTTP 200 and `{"success":true}` before continuing. Query the catalog after the request; remove or account for the synthetic symbol when interpreting counts.

For local R2 SQL, verify whether the token is present without printing it:

```powershell
mise exec -- python -c "import os; print('present' if os.getenv('WRANGLER_R2_SQL_AUTH_TOKEN') else 'absent')"
```

The monorepo's `mise.toml` (at repo root) does not automatically load `.env`; provide `WRANGLER_R2_SQL_AUTH_TOKEN` through the local secret-loading mechanism before running `wrangler r2 sql query`. Never print or pass the token as a command argument.

Run the resumable loader with one-symbol groups and an explicit checkpoint:

```powershell
python .\tools\load_sp500.py `
  --url http://127.0.0.1:8080/run `
  --batch-size 1 `
  --resume `
  --continue-on-failure `
  --state .sp500-catalog-load-state.json `
  --pipeline-runs-url $env:PIPELINE_RUNS_URL `
  --pipeline-contracts-url $env:PIPELINE_CONTRACTS_URL `
  --pipeline-underlyings-url $env:PIPELINE_UNDERLYINGS_URL
```

The state file is atomically updated after every symbol. Rerun with `--resume` after correcting a failure; completed groups are skipped and failed groups are retried. Treat `NVR` as an expected exception while the CBOE endpoint continues returning HTTP 403. Do not claim completion from process exit status alone.

Final validation must query R2 SQL and the checkpoint:

```sql
SELECT COUNT(*) AS contracts,
       COUNT(DISTINCT symbol) AS symbols
FROM options.option_contracts;

SELECT COUNT(*) AS underlyings,
       COUNT(DISTINCT symbol) AS symbols
FROM options.underlyings;
```

Confirm the checkpoint has 503 groups, 502 complete symbols, and only the documented NVR failure (or explicitly explain any changed exceptions). Confirm every successful symbol has contract and underlying rows before treating the refresh as complete.

## Query validation

```sql
SELECT run_id, status, expected_symbols, successful_symbols,
       failed_symbols, contract_count, completed_at
FROM options.refresh_runs
ORDER BY started_at DESC
LIMIT 10;
```

See [`FOLLOW-UP-ACTIONS.md`](../FOLLOW-UP-ACTIONS.md) for the staged full-dataset procedure and production hardening checklist.

## Security

Never commit API tokens, Worker secrets, `.env` files, or local `.dev.vars` files. R2 Data Catalog and R2 SQL are beta products; retain a recoverable copy until multiple complete refresh cycles have been validated.
