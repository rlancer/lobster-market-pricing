# Deployment plan: Cloudflare Pages + R2 + DuckDB-WASM

**Status:** proposed (not yet implemented)
**Goal:** Ship the options screener as a zero-backend static site on Cloudflare Pages. DuckDB-WASM runs all queries in the browser against Parquet files served from R2. No server process to operate.

---

## Why this architecture

The current backend (`backend/screener/server.py`) is a thin SQL-string builder over DuckDB. Every query it runs is standard DuckDB SQL — window functions, CTEs, date arithmetic, `information_schema` introspection — all of which executes **unchanged** in DuckDB-WASM in the browser. The dataset is small (37 MB / 370k contracts / 503 underlyings) and read-only after a batch download. So the entire FastAPI layer can be replaced by a TypeScript module running the same SQL against an in-browser DuckDB, with the data shipped as open Parquet over R2's zero-egress storage.

This keeps the columnar scan performance (sub-50ms screens), eliminates per-row D1 billing, requires no SQL dialect port, and removes any server to scale or pay for beyond R2 storage (free) and Pages bandwidth (free tier).

**Considered and rejected:**
- *Cloudflare D1 (SQLite)* — wrong engine shape (OLTP row-store) for OLAP scan/window queries; bills per row read; non-trivial SQL dialect + schema-API port. See discussion in `DEPLOYMENT-CLOUDFLARE.md` history.
- *R2 Data Catalog (Iceberg REST)* — great for multi-engine lakehouse use and incremental updates, but the browser-token auth question forces a proxy Worker, and the ACID/incremental features don't help a workload that's wholesale-refreshed from Yahoo. Overkill for v1. Open Parquet-on-R2 gets 90% of the benefit.
- *Quack remote protocol* — elegant thin-client model, but requires a persistent DuckDB server process somewhere (a VM/container), which defeats the "Cloudflare-only, zero-server" goal. Becomes attractive later if the dataset outgrows the browser.
- *Ship the `.duckdb` file in `public/`* — works and is simplest, but proprietary format and full-refetch on every data update. Parquet-on-R2 decouples data refresh from frontend deploys at low cost.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (Pages static site)                                     │
│                                                                  │
│  React UI (unchanged: App.tsx, Explorer, Notebooks, SymbolDetail)│
│        │                                                         │
│        ▼                                                         │
│  src/api.ts  ──►  src/server.ts  (port of server.py logic)       │
│        │              │                                          │
│        │              ▼                                          │
│        │         src/db.ts  (DuckDB-WASM singleton)              │
│        │              │                                          │
│        │              ▼  read_parquet('https://r2.../X.parquet') │
│        │              │   over httpfs (range requests, cached)   │
│        │              │                                          │
└────────┼──────────────┼──────────────────────────────────────────┘
         │              │
         │ (one-time fetch of Parquet files, cached by SW/Cache API)
         │              │
         ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│  Cloudflare R2 bucket  (public custom domain or r2.dev)          │
│                                                                  │
│  options/underlyings.parquet      (~small)                       │
│  options/option_contracts.parquet (~37 MB compressed, columnar)  │
│  options/download_log.parquet     (tiny, for completeness)       │
│                                                                  │
│  Cache-Control: public, max-age=3600, immutable-on-version-bump  │
└──────────────────────────────────────────────────────────────────┘
```

**Data refresh flow (off-cloud, batch):**
```
local dev box  →  mise run download  →  data/options.duckdb
                →  export to Parquet (new mise task)
                →  rclone / wrangler r2 object put  →  R2 bucket
```
No redeploy of the frontend required. The browser picks up new files on next load (cache bust via versioned filenames or a `?v=` query param read from a tiny `manifest.json`).

---

## Work breakdown

### 1. Export DuckDB tables to Parquet  *(backend, ~30 lines)*

New script `backend/screener/export_parquet.py` (and a `mise run export-parquet` task):
- `connect(read_only=True)` to `data/options.duckdb`
- For each table in `('underlyings', 'option_contracts', 'download_log')`:
  `COPY (SELECT * FROM <table>) TO 'data/parquet/<table>.parquet' (FORMAT PARQUET);`
- Print row counts + file sizes for sanity.
- Optional: also write a `manifest.json` with `{version, generated_at, files: [{name, rows, bytes, sha256}]}` for cache-busting / integrity checks from the browser.

Parquet is the natural format here: columnar (so DuckDB-WASM can push down projections and only fetch the columns a query needs via HTTP range requests), compressed (the 37 MB DuckDB file → likely 5–15 MB Parquet per table), and open.

### 2. R2 bucket + public serving  *(infra, ~15 lines of config)*

- Create R2 bucket, e.g. `screener-glm52-data`.
- Upload `parquet/*.parquet` (and `manifest.json`) — via `wrangler r2 object put` in a script, or `rclone`. New `mise run upload-r2` task wraps this.
- **Public read:** either enable the `r2.dev` subdomain (fine for a hobby project) or, better, bind a custom domain (`data.<yourdomain>`) to the bucket and let Cloudflare's CDN cache it. No Worker needed for v1 — R2 public buckets serve objects directly over HTTPS with `Cache-Control` headers.
- Set object metadata `Cache-Control: public, max-age=3600` so the browser + edge cache aggressively. Bump a version in filenames/manifest when refreshing so clients refetch.

*If we later want auth or rate-limiting, a 20-line Worker in front of R2 can gate it — but for public read-only market data, public R2 is appropriate.*

### 3. DuckDB-WASM client  *(frontend, new `src/db.ts`, ~80 lines)*

- Add `@duckdb/duckdb-wasm` + `@duckdb/duckdb-wasm` worker bundle to `frontend/package.json`.
- `src/db.ts`:
  - Lazily instantiate one DuckDB-WASM instance (using the official `@duckdb/duckdb-wasm` `createWorker` + bundle from CDN or vendored).
  - On init: `INSTALL httpfs; LOAD httpfs;` (httpfs ships with DuckDB-WASM).
  - Create views so existing SQL keeps working unchanged:
    ```sql
    CREATE VIEW underlyings      AS SELECT * FROM read_parquet('https://data.<host>/options/underlyings.parquet');
    CREATE VIEW option_contracts AS SELECT * FROM read_parquet('https://data.<host>/options/option_contracts.parquet');
    CREATE VIEW download_log     AS SELECT * FROM read_parquet('https://data.<host>/options/download_log.parquet');
    ```
  - Expose `query(sql, params?): Promise<{columns, rows}>` mirroring the Python `_rows()` helper, with the same date→isostring coercion and list/dict→string fallback the Python `_rows()` does.
  - Expose `ready: Promise<void>` so the UI can show a "loading dataset…" state on first paint.
- Handle the one-time ~10MB WASM payload + Parquet fetch with a clear loading indicator (the WASM is cached forever after first load by the SW; the Parquet is cached by HTTP).

### 4. Port `server.py` → `src/server.ts`  *(frontend, ~400 lines, mechanical)*

Port each endpoint handler to a TS function with the **exact same return shape** `api.ts` already types. The SQL strings transfer verbatim; only the surrounding Python becomes TS:

| Python (server.py) | TS function (server.ts) | Notes |
|---|---|---|
| `liquid_underlying_symbols()` | `liquidUnderlyingSymbols()` | Same SQL, same TTL memo cache (module-level `Map`). |
| `_in_clause()` | `inClause()` | Trivial. |
| `GET /api/health` | `health()` | Return `{ok:true}`. |
| `GET /api/liquidity` | `liquidity()` | Same. |
| `GET /api/stats` | `stats(liquid_only)` | Same parametric SQL. |
| `GET /api/sectors` | `sectors(liquid_only)` | Same. |
| `GET /api/underlyings` | `underlyings({sector,q,liquid_only,limit,offset})` | Same. |
| `GET /api/screen` | `screen(params)` | Same — the `near_spot_strikes` CTE, the dynamic WHERE builder, the sort whitelist. This is the biggest one but it's a 1:1 port. |
| `GET /api/symbol/{symbol}` | `symbolDetail(symbol)` | Same. |
| `GET /api/symbols` | `symbols({q,liquid_only,limit})` | Same. |
| `GET /api/tables` | `tables()` | Uses `information_schema` — **works in DuckDB-WASM**, so no change. |
| `POST /api/query` | `runQuery({sql,limit})` | Same `_sanitize_sql` guardrail (port the keyword blocklist). |
| `GET /api/notebook/premium` | `notebookPremium(params)` | Same big SQL; port the param list construction. |

Param binding: DuckDB-WASM uses the same `?` placeholders + params array as Python duckdb, so the SQL strings need **zero changes** — only the param-list assembly moves from Python lists to TS arrays.

### 5. Rewire `src/api.ts`  *(frontend, ~30 lines changed)*

The `api` object currently does `fetch(apiBase + url)`. Replace each method body with a call to the corresponding `server.ts` function. The exported `Stats`, `OptionRow`, `ScreenResponse`, etc. types stay identical, so **`App.tsx`, `Explorer.tsx`, `Notebooks.tsx`, `SymbolDetail.tsx`, `SymbolTypeahead.tsx` need zero changes.** The only caller-visible change is that `api.*` calls now return synchronously-resolved promises backed by in-browser compute instead of network requests.

One addition: `api.ready()` / a `useDbReady()` hook so `App.tsx` can gate the first screen on dataset load. Show a loading splash while `db.ready` resolves.

### 6. Loading / UX states  *(frontend, small)*

- First-paint splash: "Loading options dataset (one-time, ~X MB)…" with progress if feasible.
- Error state if R2 fetch fails (network / bucket misconfig).
- After load: identical UX to today. Screens stay sub-100ms.

### 7. Build + deploy  *(infra, ~20 lines config)*

- `frontend/vite.config.ts`: ensure the DuckDB-WASM worker `.wasm` asset is handled (the `@duckdb/duckdb-wasm` package documents the Vite setup; typically a `?worker` import + `?url` for the wasm). Add `optimizeDeps.exclude` for the package.
- `frontend/package.json`: add a `build:cf` script if needed (likely just `vite build`).
- **Cloudflare Pages:** connect the repo, set:
  - Build command: `cd frontend && npm install && npm run build`
  - Output dir: `frontend/dist`
  - Env: `VITE_R2_BASE=https://data.<host>/options` (consumed by `src/db.ts`)
- Preview deploys per PR automatically.
- Custom domain on Pages when ready.

### 8. mise tasks  *(tooling, ~15 lines in mise.toml)*

```
export-parquet  →  cd backend && uv run python -m screener.export_parquet
upload-r2       →  wrangler r2 object put screener-glm52-data/options/<file> --file ...
deploy          →  cd frontend && npm run build  (Pages auto-deploys on git push)
```

---

## Risks / open questions

1. **DuckDB-WASM bundle size.** ~10 MB wasm (gzip ~3–4 MB), cached forever after first load. Acceptable for a data tool; not great for first impression. Mitigation: loading splash + service-worker precache. Confirmed acceptable for this app.
2. **`information_schema` in DuckDB-WASM.** The `/api/tables` explorer relies on it. DuckDB-WASM supports `information_schema` — verify during port (if gaps, fall back to `duckdb_tables()` / `duckdb_columns()` system functions, which are equivalent).
3. **Date type coercion.** Python `_rows()` converts `date` → `.isoformat()`. DuckDB-WASM returns JS `Date` objects for `DATE`/`TIMESTAMP` — the `query()` helper in `db.ts` must do the same `instanceof Date → toISOString().slice(0,10)` coercion so the UI formatting (which expects `'YYYY-MM-DD'` strings) keeps working. Easy but easy to miss.
4. **Parquet row-count / `COUNT(*)` cost.** With `read_parquet` over HTTP, `COUNT(*)` scans the file. For a 370k-row single Parquet that's fine. If we ever shard by symbol, metadata-row-count tricks apply — not needed at v1.
5. **R2 public read of market data.** The data is derived from Yahoo Finance (unofficial, free). Public read is fine; no PII, no licensed data. Note Yahoo's terms in the footer (already there).
6. **Cross-origin Parquet fetch.** R2 custom domain on a different origin than Pages → CORS. R2 supports setting `Access-Control-Allow-Origin` via bucket CORS config or object metadata. One config step, not code.
7. **Cache invalidation on data refresh.** Strategy: version the manifest (`manifest.json?v=<sha>`), and version Parquet filenames or rely on `must-revalidate`. Simplest: filenames like `option_contracts.parquet` (unchanged) + a `manifest.json` with a `version` field the client appends as `?v=` on every `read_parquet` URL, forcing the browser to refetch after a refresh while still benefiting from edge caching for unchanged versions.

---

## Rollout order (small, reversible steps)

1. **Export script + local Parquet** — prove the format round-trips; run screens in local DuckDB CLI against the Parquet to confirm SQL compatibility. No Cloudflare yet.
2. **`src/db.ts` against local Parquet via `npm run dev`** — serve Parquet from `frontend/public/` temporarily, port `server.ts`, rewire `api.ts`, get the full UI working locally with zero backend. This is the milestone that de-risks everything.
3. **R2 bucket + upload** — move Parquet from `public/` to R2; point `VITE_R2_BASE` at it; verify CORS + caching.
4. **Pages deploy** — connect repo, configure build, ship.
5. **Polish** — loading states, service-worker precache for the wasm + Parquet, cache-busting manifest.

Each step is independently testable and leaves the existing FastAPI dev workflow working until step 4 (we don't delete `backend/` — it stays as the data-download/export pipeline).

---

## What stays, what goes

| Component | Fate |
|---|---|
| `backend/screener/download.py`, `sp500.py`, `greeks.py`, `db.py` | **Stay.** They're the data pipeline — run locally/offline to produce the DuckDB file. |
| `backend/screener/server.py` | **Ported to `frontend/src/server.ts`**, then the Python file becomes dead code (keep for reference, or delete). |
| `backend/screener/export_parquet.py` | **New.** Bridge between the DuckDB pipeline and R2. |
| `frontend/src/api.ts` | **Rewired** to call `server.ts` instead of `fetch`. Types unchanged. |
| `frontend/src/db.ts` | **New.** DuckDB-WASM singleton. |
| `frontend/src/server.ts` | **New.** TS port of `server.py`. |
| `frontend/src/App.tsx` + components | **Unchanged** (one small `ready` gate added). |
| `data/options.duckdb` | **Still produced** by the pipeline; source of truth for Parquet export. |
| FastAPI + uvicorn | **Gone** from production. Dev server no longer needed for the UI. |
| Vite `/api` proxy | **Removed** from `vite.config.ts`. |

---

## Effort estimate

Rough, assuming the existing code is as read:
- Export script + mise task: ~1h
- `db.ts` (DuckDB-WASM init + httpfs views): ~2h
- `server.ts` port (mechanical, mostly the `screen` query builder + notebook): ~1 day
- `api.ts` rewire + `ready` hook: ~1h
- R2 bucket + upload script + CORS: ~1h
- Vite config for wasm worker: ~1–2h (the fiddliest part, usually)
- Pages deploy + custom domain: ~30min
- Loading UX + service worker precache: ~2–3h

**Total: ~2 focused days**, most of it the `server.py → server.ts` port, which is low-risk copy-with-types work because the SQL doesn't change.
