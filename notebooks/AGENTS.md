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

## Parlay research learnings (paid for once — do not relearn)

### Grading legs via `GET /markets?tickers`

- Lake `source=kalshi_settlement` rows cover **combo / RFQ / fill tickers
  only** — the loader's settlement queue never enqueues plain legs. To grade
  individual legs, hydrate with a signed GET
  `GET /markets?tickers=<csv>&limit=1000` in chunks of 100; keep only
  `status in (settled, finalized)` with `result in (yes, no)` → 0/1, and
  cache in the local `n_leg_settlements` DuckDB memo
  (`load/record_n_leg_settlements`). Never write grades to `lake.*`.
  `hydrate_ticker_settlements` in `rolled_parlay.py` does exactly this.
- `settlement_yes` needs `result` yes/no, or bid/ask/last pinned at 0/1 —
  raw API print rows without `result` do not grade.
- No leakage: only count a settlement fetched **after** the quote it grades
  (`ticker_settlement(snaps, at_ms)`).

### As-of backtests over the lake

- The as-of quote is the **last tradable hourly quote at or before as-of of
  a market still open then**: gate on snapshot `status` (exclude
  settled/finalized/closed), `close_time > as_of`, and any settlement row
  printed before as-of disqualifies the ticker. Kalshi `close_time` is the
  settlement deadline, **not game end** — it can be days after the game.
- Hourly leg quotes are sparse before **2026-09-16** (windowed 12×200 tape
  head; Sep 13 legs only have evening quotes). Full hourly listed universe
  starts 2026-09-16. Good backtest dates: Sep 16, Sep 17 (TNF), Sep 20+.
- Legs are identified by parsing combo `category` encodings
  (`mve|COLLECTION|yes:LEG@EVENT,...`) via `combo_category` over the grouped
  tape; `sports_game_key(ticker, event_ticker)` groups legs by game.
- Group the tape **once** when grading many parlays (`grade_parlays`) —
  calling `group_by_ticker` per parlay is quadratic and the cell never
  finishes.

### Driving the marimo session (0.24.2, port 2718)

- `POST /api/kernel/execute` with header `Marimo-Session-Id: <id>` runs
  scratchpad code (SSE stream). Session ids: `GET /api/sessions`; kernel
  state: `GET /api/kernel/status` + the same header. Run notebook cells
  with `marimo._code_mode` (`ctx.run_cell`, read-before-edit, no wildcard
  redefinitions).
- Other POST endpoints need the `Marimo-Server-Token` header; the token is
  in the page DOM: `<marimo-server-token data-token=…>`. Server root is
  `notebooks/apps`, so notebooks open at `?file=<name>.py`.
- **Never click "Showing fix → Keep change"** in the notebook UI — the 0.24.2
  fix generator emits empty cells and Keep wipes the notebook (reproduced;
  restored from disk). Dismiss the prompt; authorun is blocked by it, so
  run cells via code-mode instead.
- `mo.ui.radio` dict options are `{label: value}` — `.value` returns the
  dict **value**, not the key. Verify widget semantics in the scratchpad
  before wiring cells.
- Both `.cache` sidecars (`kalshi.duckdb`, `kalshi-session.duckdb`) can be
  locked by other notebook kernels; read-only notebooks fall back to an
  in-memory `duckdb.connect()`.

### Strategy results so far (as-of 2026-09-17 18:00Z, ~30x band, net of fees)

- Same-game **2-leg** rolled parlays: realized joint **+1.46 pp** over ∏p̂,
  EV **+0.18 per $1** (236 graded). Cross-game control: **−0.53** —
  independence loses the spread, as predicted. Correlation is the edge.
- Same-game **3-leg** by naive in-band k-subset enumeration: **0/211 hits,
  EV −1.00** — enumeration mixes in mutually-exclusive legs (opposing
  scorers, both sides of a spread).
- **Correlated 3-leg semantic template** (per game: team ML `KXNFLGAME` +
  same-team player prop `KXNFLPASSTDS`/`KXNFLTD` + game total over
  `KXNFLTOTAL`; `build_correlated_3leg_parlays`, needs its own leg-ask cap
  ~0.60 because moneylines/totals quote ~0.5 and the shared 0.35 cap
  empties the book — the payout band filter does the real selection):
  Sep 13 23:00Z book 30 parlays, **3 hits = 10.0% vs ∏p̂ 2.61% (+7.39pp,
  EV +2.07/$1)**; Sep 13 20:00Z 11 parlays **0 hits (−2.60pp)**; Sep 16
  18:00Z template empty midweek (Sunday props/totals not quoted until late
  in the week); Sep 17 18:00Z 5 parlays pending the Sep 20/21 slates.
  Pooled Sep 13: **3/41 (+4.7pp)** — all 3 hits were one upset (Vikings
  ML @0.16 in GB@MIN), so promising but not a verdict; regrade after
  Sep 20/21. Week-1 TNF (Sep 10) has no template legs in the tape at all.
- **Correlated 4-leg template** (3-leg + that team's total over
  `KXNFLTEAMTOTAL`, `build_correlated_4leg_parlays`): Sep 13 23:00Z book 5
  parlays, **0/5 hits (−1.35pp, EV −1.00)** — all BUF@HOU: the Bills won but
  the game stayed low-scoring, so game-total + team-total legs both missed.
  Doubling down on "team wins ⇒ score high" makes the parlay hostage to a
  shootout, not just a win; the win⇒total link is the weak joint. Sep 17
  18:00Z: 1 parlay (NO@BAL) pending the Sep 20 slate; Sep 16 midweek the
  team-total slot is unquoted. 3-leg > 4-leg so far.
