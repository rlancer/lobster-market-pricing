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

- `src/lobster_nb/` — env, Iceberg attach, Kalshi RSA-PSS helpers, MVE parsers, parlay books/backtest, rolled correlated-leg parlay construction/as-of grading
- `apps/` — marimo notebooks only (so `marimo edit apps` does not open library modules): `lake.py` boot, `parlay_strategies.py` sports-parlay books vs lake RFQ + live CLOB (lake score tables must render without a prior `.cache` file), `lake_tape_backtest.py` Iceberg-only Kalshi sports tape (hourly listed universe vs daily candles; RFQ books + Sep 15 BUY NO fills; n>2-leg calibration on the pre-Sep-16 historical slice — realized P(all hit) vs ∏ leg mids with public-GET settlement hydration cached in `n_leg_settlements`; no live CLOB, no RFQ create/accept), `kalshi_lake_audit.py` read-only lake census (what Kalshi parlay data exists by `source`/`theme` and hourly-ingest cadence proof; no Kalshi API calls), `rolled_parlay_backtest.py` as-of-date rolled correlated-leg parlay backtest (pick a past date/hour; build same-game vs cross-game ~30:1 parlays from leg asks + taker fees; no-leakage last-quote-before grading; leg settlements hydrate by signed GET into `n_leg_settlements`; rolled-leg cost vs listed combo ask)
- `.cache/kalshi.duckdb` — local session memo + Iceberg attach state
  (gitignored). Not a warehouse: wiped on refresh, unusable from another
  machine. `strategy_runs` / `live_markets` / `live_candles_1m` are local
  tables, never `lake.*`. Cold start is clone + copy root `.env` +
  `mise run notebooks`; an empty `.cache` is correct. Historical RFQ /
  settlement / fill / listed-universe rows live in
  `lake.options.kalshi_markets` (Pipelines `cboe_kalshi_markets_v2`).
  Do not dump DuckDB into the lake.

SQL cells should use the `conn` engine from `lobster_nb.lake.connect`.

## Admin HTML snapshot

`marimo export html-wasm` is the wrong fit for `lake_tape_backtest.py`: Pyodide
cannot attach Iceberg without shipping `R2_DATA_CATALOG_TOKEN` to the browser.
Export executed HTML instead and store it in the private
`lobster-marimo-exports` R2 bucket (no r2.dev public access). The Worker
reads objects via Cloudflare R2 REST with `R2_DATA_CATALOG_TOKEN` — there is
no wrangler `r2_buckets` binding (the deploy token cannot bind R2). Serves
`GET /api/admin/marimo/lake-tape-backtest` (admin session or `ADMIN_TOKEN`).
The UI is `/admin/marimo`.

```bash
node notebooks/tools/export_marimo_to_r2.mjs
# or
mise run notebooks-export-marimo
```

The GitHub workflow **Export marimo notebook** does the same from CI. Do not
commit the HTML; `.cache/export/` is gitignored with the rest of `.cache`.
