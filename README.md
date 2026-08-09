# S&P 500 Options Screener

A free, end-to-end options screener for the S&P 500:

- **Data source:** CBOE delayed quotes (official exchange data, includes Greeks) loaded into a Cloudflare-hosted Apache Iceberg lake by the in-repo loader (`loader/`: CBOE → Cloudflare Pipelines → R2 Data Catalog). This repo consumes that lake directly over **R2 SQL** — no local database, no Parquet, no in-browser DuckDB.
- **Backend:** a lightweight **Cloudflare Worker** (`worker/`) that queries the Iceberg lake over the R2 SQL REST API and returns JSON. Deployed via `wrangler deploy`.
- **Frontend:** React + TypeScript (Vite) — a plain `fetch()` client; no WASM, no Parquet, no httpfs.
- **Toolchain:** managed with [mise](https://mise.jdx.dev) (Node, wrangler).

```
loader/ (in this repo):
  CBOE → Cloudflare Pipelines → R2 Data Catalog Iceberg tables
                                        │
                                        ▼
options-db Worker (worker/):
  /api/* → R2 SQL REST endpoint → JSON (in-isolate cache, 30 min–12 h by tier)
                                        │
                                        ▼
options-db frontend (Vite + React):
  fetch('/api/*') → render
```

The Worker is the only runtime component on this side. It's a thin SQL-string
builder + cache over the R2 SQL REST endpoint — exactly what the old FastAPI
backend was over DuckDB, ported to DataFusion SQL. Uncached lake queries take
1–6 s; the Worker memoizes them in-isolate (data is nightly-refreshed, so
staleness is bounded and the cache is safe to keep for 30 min–12 h per data
tier) so repeat/cached responses are instant.

## Repo layout

```
options-db/
├── mise.toml              # tool versions + tasks (Node, wrangler)
├── worker/                # Cloudflare Worker backend (R2 SQL → JSON)
│   ├── src/index.ts        # all endpoints, R2 SQL client, in-isolate cache
│   ├── wrangler.jsonc       # Worker config (R2_SQL_ACCOUNT_ID, R2_SQL_BUCKET vars)
│   └── .dev.vars            # local-dev R2_SQL_TOKEN (gitignored)
├── frontend/              # Vite + React + TS UI
│   ├── src/{App.tsx, api.ts, App.css, Explorer.tsx, AiChat.tsx, …}
│   ├── .env                # VITE_API_BASE → deployed Worker URL
│   └── vite.config.ts
└── loader/                # CBOE → Pipelines → R2 Data Catalog loader (Worker + Container)
    ├── src/index.js         # Worker endpoint + Container routing (cboe-to-r2)
    ├── container/loader.py  # CBOE fetch, OCC normalization, batching, refresh publication
    ├── tools/load_sp500.py  # resumable S&P 500 symbol driver
    ├── symbols/             # sp500.json manifest + constituents (name/sector enrichment)
    ├── schemas/             # Pipeline input schemas
    ├── Dockerfile           # container image (Python 3.12)
    └── wrangler.jsonc       # Worker + Container config (Pipeline URLs are secrets, not vars)

## Prerequisites

Only [mise](https://mise.jdx.dev) is required. Node 24, Python 3.12, and
wrangler are pinned in `mise.toml` and installed automatically:

```bash
mise trust        # one-time: trust this project's config
mise install      # install pinned tools
mise run sync     # npm install (frontend + worker)
mise run loader-install  # npm ci (loader)
```

## Configuration

### Worker — `R2_SQL_TOKEN` (secret)

The Worker authenticates to the R2 SQL REST API with a Cloudflare API token
that has **R2 SQL Read** on the lake bucket. It is stored as a Worker secret
(never in plaintext config):

```bash
cd worker && npx wrangler secret put R2_SQL_TOKEN
# paste the token (same one the in-repo loader uses as
# WRANGLER_R2_SQL_AUTH_TOKEN)
```

For local dev, put the same value in `worker/.dev.vars` (gitignored):

```
R2_SQL_TOKEN=cfat_...
```

`worker/wrangler.jsonc` sets the non-secret connection values as vars:

- `R2_SQL_ACCOUNT_ID` — Cloudflare account ID hosting the lake
- `R2_SQL_BUCKET` — R2 bucket with Data Catalog enabled (warehouse is `{ACCOUNT_ID}_{BUCKET}`)
- `CORS_ORIGIN` — `*` (or your Pages origin)

### Loader — `LOADER_TOKEN` (secret)

The loader Worker (`loader/`, deployed as `cboe-to-r2`) protects its `/run`
endpoint with a bearer token. Set it once as a Worker secret:

```bash
cd loader && npx wrangler secret put LOADER_TOKEN
```

For local dev, put the same value in `loader/.dev.vars` (gitignored; see
`loader/.dev.vars.example`). Pipeline ingest URLs are **secrets** (the URL
subdomain IS the credential) — deployed via `wrangler secret put`, never in
`wrangler.jsonc`. See `loader/.dev.vars.example` for the full secret list.
The root `.env` holds `WRANGLER_R2_SQL_AUTH_TOKEN` for local `wrangler r2 sql
query` validation (gitignored; see `.env.example`).

### Frontend — `VITE_API_BASE`

`frontend/.env` points the frontend at the Worker:

```
# Deployed Worker (production):
VITE_API_BASE=https://screener-api.robertlancer.workers.dev

# Local Worker dev (wrangler dev on 127.0.0.1:8787):
# VITE_API_BASE=http://127.0.0.1:8787
# (or leave empty and use the Vite /api proxy in vite.config.ts)
```

## Run it

Open two terminals (or run the Worker in the background):

```bash
mise run worker-dev    # Cloudflare Worker on http://127.0.0.1:8787
mise run frontend       # Vite dev server on http://127.0.0.1:5173
```

Then open <http://127.0.0.1:5173>. The frontend calls the Worker (via
`VITE_API_BASE`) which queries the live Iceberg lake over R2 SQL. No local
data is needed.

### Deploy

```bash
mise run worker-deploy   # npx wrangler deploy → *.workers.dev URL
mise run loader-deploy    # npx wrangler deploy → cboe-to-r2 Worker + container
# Frontend deploys to Cloudflare Pages via the deploy.yml GitHub Action
# on push to main (project: robs-options-slop, domain: lobster.mp).
# The loader deploys via the deploy-loader.yml GitHub Action (manual dispatch).
```

## API endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | `{ok:true}` |
| `GET /api/stats` | Counts of underlyings / contracts / calls / puts, last-updated timestamp (`?liquid_only=true`) |
| `GET /api/sectors` | Per-sector symbol count & avg spot price (`?liquid_only=true`) |
| `GET /api/underlyings?sector=&q=&liquid_only=&limit=&offset=` | Paginated underlyings |
| `GET /api/symbols?q=&liquid_only=&limit=` | Symbol autocomplete |
| `GET /api/liquidity` | Liquidity filter defaults + counts |
| `GET /api/screen` | The screener — see below |
| `GET /api/symbol/{symbol}` | Underlying info + all its option contracts (latest run), plus OHLC enrichment: ~1y of daily bars, latest 30d/90d realized-vol snapshot, recent dividends/splits |
| `GET /api/tables` | List lake tables (`options.*`) with columns/types, row counts, and sample rows (cached in D1; `?force=1` recomputes live) |
| `POST /api/query` | Run an arbitrary read-only SQL query against the lake (body: `{"sql":"...","limit":1000}`) |
| `GET /api/notebook/premium` | 45-day premium leaders notebook |

### `/api/screen` query parameters

`symbol`, `type` (`call`|`put`), `sector`,
`min_strike`, `max_strike`, `min_volume`, `min_open_interest`,
`min_iv`, `max_iv`, `min_delta`, `max_delta`, `in_the_money`,
`expiration_before` (`YYYY-MM-DD`), `expiration_after`,
`liquid_only` (default `true`), `near_spot_strikes` (default `50`),
`sort` (`volume` | `open_interest` | `strike` | `implied_vol` | `delta` | `gamma` | `theta` | `vega` | `bid` | `ask` | `last` | `expiration`),
`order` (`asc` | `desc`), `limit`, `offset`.

R2 SQL has no `OFFSET`, so the Worker fetches the ordered result set (capped
at 10,000 rows) once per filter signature, caches it, and pages slices
in-memory.

## UI features

- Live stats header (underlyings / contracts / calls / puts / last updated)
- Filters: symbol, call/put, sector, min volume, min open interest, IV range,
  delta range, max |moneyness|% (near-the-money), row count
- Sortable columns (volume, OI, strike, IV, greeks, etc.)
- Calls/puts color-coded; moneyness % relative to spot shown per row
- Debounced auto-refresh on filter changes
- **Click any row to dive into that symbol's option chain** — chain view with
  per-expiration calls/puts/strikes table

### Data Explorer (SQL Lab)

Browse the Iceberg lake and run arbitrary read-only SQL:

- Tables: `options.option_contracts`, `options.underlyings`, `options.refresh_runs`
- Sample queries use the `options.` schema prefix
- Only `SELECT`/`WITH`/`DESCRIBE`/`SHOW`/`EXPLAIN` are permitted (read-only)
- Backed by `GET /api/tables` and `POST /api/query`

### AI Copilot

An OpenRouter-powered chat that translates natural-language questions into
DataFusion SQL, runs them against the lake via `/api/query`, and interprets
the results. Bring your own OpenRouter API key (stored in localStorage; never
sent to our server).

## R2 SQL / DataFusion notes

The Worker builds SQL strings for the R2 SQL REST endpoint (no parameter
binding — literals are inlined via a `lit()` helper with single-quote
escaping; sort columns are whitelisted). Key dialect constraints:

- No `OFFSET` — fetch + page in-memory
- `WHERE` must come **before** `QUALIFY`
- DTE: `CAST(expiration AS DATE) - CURRENT_DATE` (expiration is TEXT)
- `spot_price` (not `spot`) is the lake column name
- No named `WINDOW` clause; inline `OVER (...)` only
- Latest snapshot: `QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1`

## Notes / caveats

- CBOE data is delayed ~15 minutes (fine for a screener). Official exchange
  data via [cdn.cboe.com](https://cdn.cboe.com/api/global/delayed_quotes/options/) — no API key.
- The in-repo loader (`loader/`, deployed Worker `cboe-to-r2`) owns CBOE ingestion (nightly run, ~502
  symbols, ~1M contracts). This repo only reads the lake.
- Greeks are supplied directly by CBOE (Black-Scholes units; `theta` per
  calendar day, `vega`/`rho` per 1.00 of vol/rate).
- The Worker cache is in-isolate and tiered by how quickly the underlying data
  changes (all bounded by the nightly refresh): screener endpoints 30 min, the
  liquid-underlyings set 60 min, `/api/query` + symbol chains 60 min
  (hash-keyed by SQL, so the chat's frame pulls and SQL Lab reruns share one
  lake fetch), and the symbol typeahead reference rows 12 h. The frontend keeps
  the full symbol universe in localStorage for 24 h and searches it
  client-side, so ticker search works across browser restarts with zero lake
  queries. To force freshness sooner, redeploy the Worker (clears the isolate
  cache) or reload with cleared site storage.

## Production build

```bash
mise run build    # outputs frontend/dist
```

The `deploy.yml` GitHub Action builds and deploys the frontend to Cloudflare
Pages on push to main (`robs-options-slop` project, `lobster.mp` domain);
dev/preview deploys for non-main branches.
