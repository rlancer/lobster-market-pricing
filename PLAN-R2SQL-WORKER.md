# Plan: Migrate Screener to R2 SQL Worker Backend (Replace DuckDB-WASM)

**Date:** 2026-08-06
**Status:** IMPLEMENTED (PR #4 merged). Worker deployed at `screener-api.robertlancer.workers.dev`. This document is a historical record of the migration plan.

> **Note (2026-08-06):** The loader project (formerly `cboe-to-r2` / `options-lake`, a separate repo) has been merged into this monorepo as `loader/`. References below to "the loader project" or "the `cboe-to-r2` / `options-lake` repo" now point to `loader/`. The `options-db` repo is now a single monorepo containing all three components: `loader/`, `worker/`, `frontend/`.

---

## Goal

Replace the browser-side DuckDB-WASM + Parquet-from-R2 architecture with a
lightweight **Cloudflare Worker backend** that queries the CBOE Iceberg lake
directly over **R2 SQL** and returns JSON to a plain React frontend.

This removes:
- The ~40 MB DuckDB-WASM download (bad first-load UX)
- The `data/options.duckdb` local middleman
- The `download_cboe.py` / `hydrate_lake.py` / `export_parquet.py` /
  `upload-r2` ETL chain (the lake becomes the single source of truth)

The frontend becomes a plain `fetch()` client. No WASM, no httpfs, no Parquet.

---

## Why this works (measured, not assumed)

R2 SQL latency was tested against the live lake
(`3315bb3e7d2e3556bfea6fb3947a890e_cboe-options-data`):

| Query | Uncached latency | Notes |
|-------|-----------------|-------|
| `stats` (COUNT contracts/underlyings) | 1.2 s | |
| `stats` calls/puts GROUP BY | 3.1 s | |
| Liquidity (GROUP BY HAVING over join) | 3.4 s | 374 liquid symbols |
| `screen` simple filter+join+order+limit | 6.0 s | |
| `screen` with `near_spot_strikes` CTE (window over 500k) | 4.4 s | **did not time out** |
| `screen` COUNT | 1.1 s | |
| `symbol_detail` contracts (latest run) | 1.3 s | |

**Verdict:** Viable with caching. The dataset only changes on nightly loader
runs, so results are cached 5–10 min in the Worker isolate (Map). Cached
responses are instant; cold first-load ~5–10 s total across the handful of
queries the homepage fires — acceptable, and far better than 40 MB WASM.

---

## R2 SQL constraints discovered (must design around)

1. **No `OFFSET`** — unsupported. Screen/underlyings fetch the ordered result
   set (capped at R2 SQL's 10,000-row LIMIT) once per filter signature, cache
   it, and page slices in-memory (`array.slice(offset, offset+limit)`).
2. **No parameter binding over REST** — literals are inlined via a `lit()`
   helper with single-quote escaping. Sort columns are whitelisted to prevent
   injection.
3. **DataFusion dialect differences** from DuckDB:
   - `spot_price` not `spot` (the lake column name)
   - `WHERE` must come **before** `QUALIFY` (reversed from DuckDB)
   - DTE: `CAST(expiration AS DATE) - CURRENT_DATE` returns integer days
     directly (no `date_diff`; DuckDB's `expiration - CURRENT_DATE` on a DATE
     column also works but the lake stores `expiration` as TEXT so the CAST
     is required)
   - No named `WINDOW` clause; inline `OVER (...)` only
4. **Latest-snapshot pattern:** the lake is append-only (multiple loader runs
   accumulate). Every "current" query selects each symbol's newest underlying
   via:
   ```sql
   SELECT ... FROM options.underlyings
   QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1
   ```
   A `LATEST_UNDERLYING` subquery constant is reused (see `worker/src/index.ts`).
   Contracts for a symbol are filtered to that symbol's latest `run_id`.
5. **Resource-gated queries:** `COUNT(DISTINCT)`, window functions over large
   partitions, and 3+ way joins can be rejected with a 400 budget error. The
   `screen` CTE (window over 500k, join to underlyings) **passed** in testing
   but keep `LIMIT` on all queries and prefer `approx_distinct` where distinct
   counts are needed.

---

## What's already done

### Loader project (`loader/`, in this monorepo)
The Iceberg lake data gap is **fixed and live**:
- `options.underlyings` recreated with `name` + `sector` columns (Pipeline
  schemas are immutable, so the old stream+sink+table were dropped, the table
  purged via the Iceberg REST catalog, and a new stream+sink+pipeline created
  with the enriched schema).
- `container/loader.py` now enriches underlyings from
  `symbols/sp500_constituents.json` (503-symbol Wikipedia manifest, baked into
  the container image).
- A full 503-symbol reload ran: **502 successful, NVR HTTP 403 (documented
  exception), 522,408 contracts**. Verified: 502 underlyings, all with
  name+sector.
- PR: https://github.com/rlancer/options-lake/pull/1 (branch
  `feat/underlyings-name-sector`).

### Consumer project (`options-db` repo)
- `backend/screener/hydrate_lake.py` (lake→DuckDB bridge) — **REMOVED** in PR #4.
- The Worker is implemented at `worker/src/index.ts` (ports the former
  `server.py` endpoints to R2 SQL with caching + fetch-and-page pagination).
  `worker/wrangler.jsonc`, `worker/package.json`, `worker/tsconfig.json` are
  in place.
- PR #3 (`feat/lake-consumer`, Python `hydrate_lake.py` + DuckDB/Parquet path)
  — **CLOSED**, superseded by PR #4 (this Worker):
  https://github.com/rlancer/options-db/pull/3

### Live lake state
- Warehouse: `3315bb3e7d2e3556bfea6fb3947a890e_cboe-options-data`
- Tables: `options.option_contracts`, `options.underlyings`, `options.refresh_runs`
- `option_contracts`: ~1.06M rows / 504 symbols, Greeks/quotes populated
- `underlyings`: 502 symbols, all with `name`+`sector`+`spot_price`
- NVR: HTTP 403 (documented; the only failed symbol)
- R2 SQL token: in `options-db/.env` as `R2_SQL_TOKEN` (gitignored; same
  token as the loader project's `WRANGLER_R2_SQL_AUTH_TOKEN`)

---

## Architecture (target)

```
loader/ (in this monorepo):
  CBOE → Cloudflare Pipelines → R2 Data Catalog Iceberg tables
                                        │
                                        ▼
options-db Worker (this repo, worker/):
  /api/* → R2 SQL REST endpoint → JSON (cached 5–10 min in-isolate)
                                        │
                                        ▼
options-db frontend (Vite + React):
  fetch('/api/*') → render (no DuckDB-WASM, no Parquet)
```

The Worker is the only new runtime component. It's a thin SQL-string builder
+ cache over the R2 SQL REST endpoint — exactly what `server.py` was over
DuckDB, ported to DataFusion SQL.

---

## Implementation steps

### 1. Finish + test the Worker (`worker/`)

The skeleton at `worker/src/index.ts` is feature-complete but needs:

- **Install deps + typecheck:**
  ```bash
  cd worker && npm install && npx wrangler types && npx tsc --noEmit
  ```
- **Set the R2 SQL token as a secret** (not a var — it's a credential):
  ```bash
  cd worker && npx wrangler secret put R2_SQL_TOKEN
  # paste the token from options-db/.env (R2_SQL_TOKEN value)
  ```
  `wrangler.jsonc` already has `R2_SQL_ACCOUNT_ID` and `R2_SQL_BUCKET` as vars.
- **Local dev:** `npx wrangler dev` then hit endpoints with curl. The Worker
  hits the live lake in dev (no local data needed). Verify:
  - `curl http://127.0.0.1:8787/api/health` → `{ok:true}`
  - `curl http://127.0.0.1:8787/api/stats` → counts
  - `curl 'http://127.0.0.1:8787/api/screen?limit=5'` → 5 rows with
    name/sector/moneyness_pct
  - `curl http://127.0.0.1:8787/api/symbol/AAPL` → underlying + contracts
  - `curl http://127.0.0.1:8787/api/sectors`
  - `curl http://127.0.0.1:8787/api/liquidity`
  - `curl 'http://127.0.0.1:8787/api/notebook/premium?limit=5'`
- **Fix the `stats` liquid-only branch** — the `puts` calculation in
  `worker/src/index.ts` is wrong (it does `num(c[0]?.n) - num(cp[0]?.n) - 0`
  which is contracts - calls, but `c` is the contracts count and `cp` is
  calls; should be a separate puts count query, or `contracts - calls`).
  Compare against `server.py`'s `stats()`.
- **Deploy:** `npx wrangler deploy`. Note the `*.workers.dev` URL.

### 2. Rewire the frontend to `fetch()` the Worker

The frontend currently calls in-browser `server.ts` (DuckDB-WASM). Replace
with HTTP calls to the Worker. The `api.ts` type interfaces stay identical —
only the method bodies change from `server.fn()` to `fetch()`.

- **`frontend/src/api.ts`:** rewrite each `api.*` method to
  `fetch(VITE_API_BASE + path).then(r => r.json())`. `VITE_API_BASE` defaults
  to the Worker URL (set in `frontend/.env` as `VITE_API_BASE`). Remove the
  `dbReady` import and the `useDbReady` hook (or make it always-ready).
- **`frontend/src/server.ts`:** delete (the DuckDB-WASM port is gone).
- **`frontend/src/db.ts`:** delete (DuckDB-WASM singleton is gone).
- **`frontend/package.json`:** remove `@duckdb/duckdb-wasm` and
  `apache-arrow` deps.
- **`frontend/vite.config.ts`:** remove the DuckDB-WASM worker asset handling
  and any `optimizeDeps.exclude` for duckdb. Keep the `/api` proxy pointing at
  `http://127.0.0.1:8787` (the Worker dev port) for local dev, OR just use
  `VITE_API_BASE` and drop the proxy.
- **Components:** search for `useDbReady` / `dbReady` / `__dbQuery` and replace
  the loading gate with an always-ready state (or a simple "fetching…" per-
  request spinner). The components that call `api.*` need no changes if the
  return shapes are preserved.
- **AiChat.tsx:** it references `option_contracts`/`underlyings`/
  `download_log` DuckDB tables — repoint it to the Worker's `/api/query`
  endpoint (which proxies read-only SQL to R2 SQL) or update its table list to
  the lake tables (`options.option_contracts`, `options.underlyings`,
  `options.refresh_runs`).

### 3. Remove the DuckDB/Parquet ETL chain (now dead)

Under the new architecture the frontend never touches Parquet or DuckDB, so
the entire local ETL is dead code. **Decide what to delete vs. keep as
legacy:**

- `backend/screener/hydrate_lake.py` — was the lake→DuckDB bridge; no longer
  needed. Delete (or keep as a CLI debugging tool if useful).
- `backend/screener/download_cboe.py` — legacy direct-CBOE downloader. Delete
  (the loader project owns CBOE ingestion now).
- `backend/screener/export_parquet.py` — DuckDB→Parquet. Delete.
- `backend/screener/server.py` — the FastAPI backend. Delete (the Worker
  replaces it). **Port any query the Worker is missing before deleting** —
  use `server.py` as the reference for SQL shapes.
- `backend/screener/db.py` — DuckDB schema/connection. Delete.
- `backend/screener/sp500.py` — Wikipedia constituents. The lake now carries
  name/sector, so this is only needed if you want a local fallback. Delete
  unless you want the fallback.
- `mise.toml` tasks: remove `download-cboe`, `hydrate-lake`,
  `export-parquet`, `upload-r2`, `refresh`. Add a `worker-dev` task
  (`cd worker && npx wrangler dev`) and `worker-deploy`
  (`cd worker && npx wrangler deploy`). Keep `sync`, `backend` (maybe remove),
  `frontend`, `build`.
- `.github/workflows/refresh-data.yml` — the nightly Parquet→R2 upload
  workflow. Delete (no Parquet to upload). The loader project handles
  ingestion now.
- `data/` dir, `data/parquet/` — local artifacts. Delete / gitignore (already
  gitignored).
- `DEPLOYMENT-CLOUDFLARE.md` — the DuckDB-WASM/R2-Parquet plan doc. Delete or
  replace with a short note pointing at the Worker architecture.

### 4. Update `README.md`

Rewrite the data-source and architecture sections to reflect the Worker +
R2 SQL architecture. Remove the DuckDB-WASM, Parquet, and local ETL
documentation. Document:
- The Worker is the backend (`worker/`), deployed via `wrangler deploy`.
- `VITE_API_BASE` env var pointing the frontend at the Worker.
- The `R2_SQL_TOKEN` Worker secret.
- That the loader project (`loader/`) owns ingestion.

### 5. Verify end-to-end

- `cd worker && npx wrangler dev`
- `cd frontend && npm run dev` (with `VITE_API_BASE` pointing at the Worker)
- Open http://127.0.0.1:5173, exercise: stats header, sector filter, screen
  with filters/sort/pagination, symbol detail (chain view), data explorer
  (`/api/query`), premium notebook.
- Confirm the first-load is fast (no 40 MB WASM), and screens are responsive
  (cached after first hit).

---

## Key files reference

| File | Role |
|------|------|
| `worker/src/index.ts` | The Worker — all endpoints, R2 SQL client, cache. **Exists, needs testing + stats fix.** |
| `worker/wrangler.jsonc` | Worker config. `R2_SQL_TOKEN` is a secret (set via `wrangler secret put`). |
| `backend/screener/server.py` | The reference implementation — port any missing query to the Worker before deleting. |
| `frontend/src/api.ts` | API types + client. Types stay; method bodies change to `fetch()`. |
| `frontend/src/server.ts` | DuckDB-WASM port — **delete**. |
| `frontend/src/db.ts` | DuckDB-WASM singleton — **delete**. |

---

## Open decisions (for the implementing session)

1. **Delete vs. keep `backend/` as legacy?** The Worker replaces it entirely.
   Recommended: delete `server.py`, `db.py`, `download_cboe.py`,
   `export_parquet.py`, `hydrate_lake.py`; keep `sp500.py` only if a local
   Wikipedia fallback is wanted (the lake now carries name/sector, so it's
   redundant). The `backend/` dir can be removed wholesale if the Worker is
   the only backend.

2. **Data Explorer (`/api/query`) over the lake:** the Worker proxies
   read-only SQL to R2 SQL. The Data Explorer UI lets users run arbitrary
   SQL — this works but users must use lake table names
   (`options.option_contracts`, not `option_contracts`). Update the UI's
   sample queries and table-list sidebar to reflect lake tables. The
   `/api/tables` endpoint already lists lake tables via `SHOW TABLES IN options`.

3. **AiChat tool:** if it runs SQL via the old DuckDB path, repoint it to
   `/api/query`. Its table references need updating to lake table names.

4. **Cache invalidation:** the Worker cache is time-based (5 min). If a loader
   run completes and you want immediate freshness, either wait 5 min or add a
   `POST /api/cache-clear` endpoint (simple `cache.clear()`) protected by a
   token. Not needed for nightly-refreshed data.

5. **Compaction:** enable automatic compaction on the lake bucket to keep
   query latency low (file count dominates R2 SQL scan time):
   ```bash
   npx wrangler r2 bucket catalog compaction enable cboe-options-data --target-size 128
   npx wrangler r2 bucket catalog snapshot-expiration enable cboe-options-data --older-than-days 7 --retain-last 10
   ```
   This also reclaims the ~540k duplicate contract rows from the first (pre-
   recreation) loader run.

---

## R2 SQL connection values

| Value | Value |
|-------|-------|
| Account ID | `3315bb3e7d2e3556bfea6fb3947a890e` |
| Bucket | `cboe-options-data` |
| Warehouse | `3315bb3e7d2e3556bfea6fb3947a890e_cboe-options-data` |
| REST endpoint | `https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT}/r2-sql/query/{BUCKET}` |
| Token | `R2_SQL_TOKEN` in `options-db/.env` (gitignored); same as loader's `WRANGLER_R2_SQL_AUTH_TOKEN` |
| Tables | `options.option_contracts`, `options.underlyings`, `options.refresh_runs` |
| `underlyings` columns | `symbol, name, sector, spot_price, description, run_id, as_of_date, fetched_at, __ingest_ts` |
| `option_contracts` columns | `symbol, expiration(TEXT), type, strike, last, bid, ask, volume, open_interest, implied_vol, delta, gamma, theta, vega, rho, in_the_money, theo, bid_size, ask_size, run_id, as_of_date, fetched_at, __ingest_ts` |
