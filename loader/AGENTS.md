# CBOE Options Loader — Agent Instructions

## Scope

This package (the `loader/` directory of the `options-db` monorepo) loads the 503-symbol S&P 500 manifest from CBOE into Cloudflare Pipelines and R2 Data Catalog tables. The frontend and R2-SQL screener Worker live at the repo root (`frontend/`, `worker/`). Work locally with raw Python unless the task explicitly requests Worker, Container, or GitHub Actions changes.

## Current verified state

- Manifest: `symbols/sp500.json` — 503 unique symbols.
- Canonical checkpoint: `.sp500-catalog-load-state.json`.
- Latest load: 502 complete symbols; NVR failed with CBOE HTTP 403.
- NVR is intentionally recorded in `symbols/sp500-load-exceptions.json`.
- Latest observed catalog counts included synthetic `ZZZ` smoke-test data; exclude `ZZZ` from S&P counts.
- Pipeline HTTP authentication is disabled for the experiment. Do not enable schedules or call this production-ready until ingestion is authenticated and alerting/retention exist.

## Required operating gates

1. Before any full load, send a unique synthetic contract record to the contracts stream and require HTTP 200 with `success: true`.
2. Include `User-Agent: cboe-to-r2/0.2` on Pipeline POSTs. The contract endpoint returned Cloudflare error 1010 without it.
3. Use `WRITE_MODE=pipeline` for real writes. `stdout` prints payloads and does not populate R2.
4. Use `tools/load_sp500.py` with `--batch-size 1`, `--resume`, `--continue-on-failure`, and an explicit state path.
5. Never delete or overwrite a checkpoint to bypass failures. Retry failed groups; completed groups must remain skipped.
6. Treat NVR's HTTP 403 as an expected explicit exception unless the CBOE source changes.
7. Do not claim completion until the checkpoint and R2 SQL both verify the result.

## Pipeline and catalog identifiers

```text
Warehouse: 3315bb3e7d2e3556bfea6fb3947a890e_cboe-options-data
Runs:      https://REDACTED.ingest.cloudflare.com
Contracts: https://REDACTED.ingest.cloudflare.com
Underlyings:https://REDACTED.ingest.cloudflare.com
Tables: options.option_contracts, options.underlyings, options.refresh_runs
```

The `options.underlyings` schema now includes `name` (string, optional) and `sector` (string, optional), enriched from the S&P 500 Wikipedia constituents manifest `symbols/sp500_constituents.json`. CBOE's delayed-quotes endpoint does not return a company name or sector, so the loader merges them from the static manifest at publish time (`load_constituents()` in `container/loader.py`). The manifest is baked into the container image (`COPY symbols/sp500_constituents.json /app/sp500_constituents.json`); symbols missing from the manifest fall back to `name = symbol`, `sector = 'Unknown'`.

Recreating the `options.underlyings` Iceberg table (required because Pipeline stream schemas are immutable — see `references/pipelines/gotchas.md`) requires dropping the old `cboe_underlyings` stream + sink, dropping the Iceberg table via the catalog, then recreating the stream + sink with the enriched schema (`schemas/underlyings.json`) and running a full CBOE underlyings reload.

Inspect existing infrastructure before changing it:

```powershell
npx wrangler pipelines streams get cboe_option_contracts
npx wrangler pipelines get cboe_option_contracts_pipeline
npx wrangler pipelines sinks get cboe_option_contracts_sink
```

## Secrets

`WRANGLER_R2_SQL_AUTH_TOKEN` is stored in the root `.env` (gitignored; see `.env.example` at repo root). `mise.toml` does not automatically load `.env`; verify presence without exposing the value:

```powershell
mise exec -- python -c "import os; print('present' if os.getenv('WRANGLER_R2_SQL_AUTH_TOKEN') else 'absent')"
```

Never print the token or pass it as a command-line argument.


> Run all commands in this section from the `loader/` directory.

## Local load

Terminal 1:

```powershell
$env:WRITE_MODE = "pipeline"
$env:PIPELINE_RUNS_URL = "https://REDACTED.ingest.cloudflare.com"
$env:PIPELINE_CONTRACTS_URL = "https://REDACTED.ingest.cloudflare.com"
$env:PIPELINE_UNDERLYINGS_URL = "https://REDACTED.ingest.cloudflare.com"
python .\container\loader.py
```

Terminal 2:

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

Monitor with `Invoke-RestMethod http://127.0.0.1:8080/status`.

## Validation

Compile changed Python:

```powershell
python -m py_compile container/loader.py tools/load_sp500.py
```

Validate both checkpoint and catalog. At minimum query contract and underlying counts, then confirm 503 checkpoint groups with only the documented NVR failure. Account for synthetic smoke-test rows.

## Implementation invariants

- `fetch_chain()` derives `Retry-After` from `last_error`.
- `pipeline_url()` falls back to environment URLs when request header overrides are empty.
- Pipeline records use the loader User-Agent and idempotency keys.
- The checkpoint is atomically written after each symbol.

Human-facing procedure: `README.md`. Staged production hardening: `NEXT_STEPS.md`.
