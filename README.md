# S&P 500 Options Screener

A free, end-to-end options screener for the S&P 500:

- **Data source:** CBOE delayed quotes (official exchange data, includes Greeks) via a nightly GitHub Actions ETL → Parquet → Cloudflare R2
- **Storage / indexing:** [DuckDB](https://duckdb.org) — a single embedded `data/options.duckdb` file
- **Backend:** FastAPI that queries DuckDB
- **Frontend:** React + TypeScript (Vite)
- **Toolchain:** managed with [mise](https://mise.jdx.dev) (Python via `uv`, Node, `uv` itself)

```
screener_glm52/
├── mise.toml                 # tool versions + tasks
├── backend/
│   ├── pyproject.toml
│   └── screener/
│       ├── db.py             # DuckDB schema + connection
│       ├── sp500.py          # Wikipedia S&P 500 constituent list
│       ├── download_cboe.py  # fetch underlyings + option chains from CBOE -> DuckDB
│       └── server.py         # FastAPI screener API
├── frontend/                 # Vite + React + TS UI
│   └── src/{App.tsx, api.ts, App.css}
└── data/options.duckdb       # created on first download (gitignored)
```

## Prerequisites

Only [mise](https://mise.jdx.dev) is required. Everything else (Python 3.12, Node 22, `uv`) is
pinned in `mise.toml` and installed automatically:

```bash
mise trust        # one-time: trust this project's config
mise install      # install pinned tools
mise run sync     # uv sync (backend) + npm install (frontend)
```

## 1. Download options data (CBOE)

```bash
# Quick smoke test (first 25 symbols):
mise run download-cboe -- --limit 25

# Full S&P 500 (~503 symbols, one call each, ~5 min):
mise run download-cboe
```

This fetches the S&P 500 constituent list from Wikipedia and, for each symbol, the **full
CBOE delayed-quotes option chain** — every expiration and all Greeks (`delta`, `gamma`,
`theta`, `vega`, `rho`), plus `theo`, `bid_size`, `ask_size`, IV, bid/ask, volume, and open
interest — in a **single call per symbol**, and writes them into `data/options.duckdb`.

The full refreshes and Parquet→R2 upload are automated by the `refresh-data` GitHub Action
(cron after market close); you generally don't run this by hand.

```bash
# One-shot local ETL (download -> export -> upload to R2):
mise run refresh
```

## 2. Run it

Open two terminals:

```bash
mise run backend    # FastAPI on http://127.0.0.1:8001
mise run frontend   # Vite dev server on http://127.0.0.1:5173
```

Then open <http://127.0.0.1:5173>. The Vite dev server proxies `/api/*` to the backend.

### API endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/stats` | Counts of underlyings / contracts / calls / puts, last-updated timestamp |
| `GET /api/sectors` | Per-sector symbol count & avg spot price |
| `GET /api/underlyings?sector=&q=&limit=&offset=` | Paginated underlyings |
| `GET /api/symbols?q=` | Symbol autocomplete |
| `GET /api/screen` | The screener — see below |
| `GET /api/tables` | List all tables with columns/types and row counts |
| `POST /api/query` | Run an arbitrary read-only SQL query (body: `{"sql":"...","limit":1000}`) |
| `GET /api/symbol/{symbol}` | Underlying info + all its option contracts (for the chain view) |

### `/api/screen` query parameters

`symbol`, `type` (`call`\|`put`), `sector`,
`min_strike`, `max_strike`, `min_volume`, `min_open_interest`,
`min_iv`, `max_iv`, `min_delta`, `max_delta`, `in_the_money`,
`expiration_before` (`YYYY-MM-DD`), `expiration_after`,
`sort` (`volume` \| `open_interest` \| `strike` \| `implied_vol` \| `delta` \| `gamma` \| `theta` \| `vega` \| `bid` \| `ask` \| `last` \| `expiration`),
`order` (`asc` \| `desc`), `limit`, `offset`.

## UI features

- Live stats header (underlyings / contracts / calls / puts / last updated)
- Filters: symbol, call/put, sector, min volume, min open interest, IV range,
  delta range, max |moneyness|% (near-the-money), row count
- Sortable columns (volume, OI, strike, IV, greeks, etc.)
- Calls/puts color-coded; moneyness % relative to spot shown per row
- Debounced auto-refresh on filter changes
- **Click any row to dive into that symbol's option chain** — see chain view below

### Symbol chain view

Click a screener row (e.g. NVDA) to open a per-symbol detail view:

- Header shows symbol, name, sector, spot, total contracts, and # of expirations
- A horizontal **expiration selector** lists every expiry with days-to-expiry;
  click one to regroup the chain
- A classic **calls / strike / puts** chain table for the selected expiration:
  each row is a strike, call greeks/quotes on the left, put greeks/quotes on the
  right, in-the-money cells shaded, strike center column sticky, hover a strike
  for moneyness vs spot
- Per-expiration summary (strikes, calls/puts, total volume & OI, DTE)
- ← Back to screener returns to the filtered list
- Backed by `GET /api/symbol/{symbol}` (underlying info + all its contracts,
  ordered for chain grouping)

### Data Explorer

The **Data Explorer** tab lets you browse the DuckDB database and run arbitrary
SQL:

- Left sidebar lists every table with row counts; click a table to see its
  columns + types. Click a column name to append it to the query.
- SQL editor with sample queries (buttons `#1`–`#5`) and `Ctrl`+`Enter` to run.
- Results render as a scrollable table with a row index, row count, elapsed
  time, and truncation notice (capped at 1000 rows).
- Backed by `GET /api/tables` and `POST /api/query` (read-only: only
  `SELECT`/`WITH`/`DESCRIBE`/`SHOW`/`EXPLAIN`/`PRAGMA` are permitted).

## Notes / caveats

- CBOE data is delayed ~15 minutes (fine for a screener). The data source is official
  exchange data (via [cdn.cboe.com](https://cdn.cboe.com/api/global/delayed_quotes/options/))
  and requires no API key.
- The ETL runs nightly on a GitHub-hosted runner from GitHub/Azure IPs; scheduled runners
  can occasionally be delayed or flaky. If a refresh fails, the last-good Parquet in R2 is
  preserved (the job stops before the R2 upload), and you can re-run manually via
  `workflow_dispatch` on the `refresh-data` workflow.
- Greeks are supplied directly by CBOE (already in Black-Scholes units; `theta` per calendar
  day, `vega`/`rho` per 1.00 of vol/rate — same conventions the UI expects). No local
  Black-Scholes recompute is needed.
- DuckDB holds the whole dataset in a single file you can query directly:

  ```bash
  mise exec -- python -c "import duckdb; c=duckdb.connect('data/options.duckdb'); print(c.execute('SELECT symbol, COUNT(*) FROM option_contracts GROUP BY 1 ORDER BY 2 DESC LIMIT 5').fetchall())"
  ```

### GitHub Actions

A nightly `refresh-data.yml` workflow automates the ETL: `download-cboe` →
`export-parquet` → `upload-r2` (mirrors `mise run refresh`). It schedules after US market
close (01:00 UTC Mon–Fri) and can be triggered manually via the Actions UI. It does not
touch the `deploy.yml` deploy workflow.

The `upload-r2` task and the workflow both authenticate with the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets set in the repo.

## Production build

```bash
mise run build    # outputs frontend/dist
```
