# Research notebooks (marimo)

Local-only uv project. The product API does not use this DuckDB file.

## Run

From the repo root (mise provides Python 3.12 and uv):

```bash
mise install
mise run notebooks-sync
mise run notebooks
```

`mise run notebooks` starts marimo with `--no-token` so
[marimo-pair](https://github.com/marimo-team/marimo-pair) can attach
(http://127.0.0.1:2718). Notebooks load the gitignored root `.env` via
python-dotenv (do not load that file through mise — it cannot parse the
multi-line Kalshi PEM). Open the notebook UI; the kernel is the source of truth.

Do **not** edit `apps/*.py` from the IDE while a session is running — use
`marimo._code_mode` from the pair scratchpad. Do **not** print secret values.
Do **not** `CREATE`/`INSERT`/`DELETE` on the attached `lake.*` catalog.

## Layout

- `src/lobster_nb/` — env, Iceberg attach, Kalshi RSA-PSS helpers, MVE parsers, parlay books/backtest
- `apps/` — marimo notebooks only (so `marimo edit apps` does not open library modules): `lake.py` boot, `parlay_strategies.py` sports-parlay books vs lake RFQ + live CLOB (lake score tables must render without a prior `.cache` file)
- `.cache/kalshi.duckdb` — local session memo + Iceberg attach state
  (gitignored). Not a warehouse: wiped on refresh, unusable from another
  machine. `strategy_runs` / `live_markets` / `live_candles_1m` are local
  tables, never `lake.*`. Cold start is clone + copy root `.env` +
  `mise run notebooks`; an empty `.cache` is correct. Historical RFQ /
  settlement / fill / listed-universe rows live in
  `lake.options.kalshi_markets` (Pipelines `cboe_kalshi_markets_v2`).
  Do not dump DuckDB into the lake.

SQL cells should use the `conn` engine from `lobster_nb.lake.connect`.
