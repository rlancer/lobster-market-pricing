# S&P 500 Options Screener

A free, end-to-end options screener for the S&P 500:

- **Data source:** Yahoo Finance via [`yfinance`](https://github.com/ranaroussi/yfinance) (free, no API key)
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
│       ├── download.py       # fetch underlyings + option chains -> DuckDB
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

## 1. Download options data

```bash
# Quick smoke test (first 25 symbols, 3 expirations each):
mise run download -- --fresh --limit 25 --max-expirations 3

# Full S&P 500 (takes a while — rate-limited to ~5 req/s by Yahoo):
mise run download -- --fresh
```

This fetches the S&P 500 constituent list from Wikipedia, spot prices, and full call/put
option chains (strikes, bid/ask, volume, open interest, IV, greeks) and writes them into
`data/options.duckdb`.

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

- Yahoo Finance is an unofficial data source and is rate-limited; the full download
  throttles each symbol (`time.sleep`) and logs failures to the `download_log` table.
- Greeks (`delta`, `gamma`, `theta`, `vega`, `rho`) are returned by Yahoo where available
  and may be `NULL` for very short-dated or illiquid contracts. See *Recomputing
  Greeks* below to backfill them yourself.
- DuckDB holds the whole dataset in a single file you can query directly:

  ```bash
  mise exec -- python -c "import duckdb; c=duckdb.connect('data/options.duckdb'); print(c.execute('SELECT symbol, COUNT(*) FROM option_contracts GROUP BY 1 ORDER BY 2 DESC LIMIT 5').fetchall())"
  ```

### Recomputing Greeks

Yahoo's Greeks are often `NULL` for short-dated / illiquid contracts.
`backend/screener/greeks.py` recomputes all five Greeks from the
Black-Scholes model (zero dividends, `q = 0`) using the spot (`underlyings.spot`),
strike, `implied_vol`, type, and expiration already in DuckDB, and writes them
back into `option_contracts` keyed on `(symbol, expiration, type, strike)`.

Conventions (match the UI / Yahoo):

- `theta` is per **calendar day**
- `vega` is per **1.00 (100%)** change in volatility
- `rho` is per **1.00 (100%)** change in rate

The risk-free rate defaults to a constant `r = 0.043` (no network calls);
override with `--rate`. Rows with `T <= 0` (expired) or missing / `<= 0` IV,
spot, or strike are skipped and left `NULL`.

```bash
# recompute every row (idempotent):
mise run greeks
# recompute just NVDA with a different rate:
mise run greeks -- --only NVDA --rate 0.045
# preview without writing:
mise run greeks -- --dry-run --limit 20
# only fill rows whose greeks are currently NULL:
mise run greeks -- --null-only
```

Verify NULL coverage:

```bash
cd backend && uv run python -c "import duckdb; c=duckdb.connect('../data/options.duckdb'); print(c.execute('SELECT COUNT(*) total, SUM(CASE WHEN delta IS NULL THEN 1 ELSE 0 END) null_delta FROM option_contracts').fetchone())"
```

## Production build

```bash
mise run build    # outputs frontend/dist
```
