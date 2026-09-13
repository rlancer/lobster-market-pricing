# Kalshi sports parlay analysis — agent handoff

Working brief for a **new session on `origin/main`**. Analyze whether Kalshi
sports parlays are mispriced vs independence / correlation. Open a PR against
`main`. Do not merge unless asked. Do not ingest the full sports catalog. Do
not add sports to Chat `suggest_trades`. Prefer the lake over live Kalshi GETs
(public Trade API 429s easily).

## What already shipped

Ingest (hourly `kalshi-markets-hourly`, series `KXMVE` in
`loader/symbols/kalshi-series.json`):

- Open MVE combos with structured `mve_selected_legs` (≥2) **plus those named
  legs only** — not the NFL/NBA catalog.
- Combo `category` encoding on the existing stream (no new Pipelines columns):
  `mve|{collection}|{yes|no}:{LEG},…`
- Rows: `theme=sports`, combo `market_type=multivariate`,
  `related_symbol=null`.
- Lookback: `KALSHI_SPORTS_LOOKBACK_DAYS=30`,
  `KALSHI_SPORTS_LOOKBACK_MAX=200`. Daily candlesticks
  (`GET /markets/candlesticks?period_interval=1440`). Candle rows set
  `fetched_at` to the candle end so latest-wins keeps history.
- Settlement 0/1 snapshots are **not** published (they would overwrite useful
  quotes).

Experiment:

- `GET /api/experiments/kalshi-parlays` — design `kalshi-parlays-v3`
- UI `/experiments/kalshi-parlays`
- Math: `worker/src/kalshi-parlay.ts`
- Run: `worker/src/kalshi-parlay-experiment.ts` (`buildSportsRows`)
- Sports SQL in `worker/src/index.ts`: latest-wins per `market_ticker`,
  `LIMIT 800`, cache key `kalshi_parlays_v3`
- Chat is not a sportsbook. Research `/api/research/{ticker}/kalshi` filters
  `related_symbol`; sports have `related_symbol=null`.

Production lake (after 2026-09-13 18:24 UTC `KXMVE` pass, 19/19 series):

- **3882** sports/MVE rows, **540** distinct tickers
- `fetched_at` **2026-08-15 → 2026-09-13**
- Notebook: `sports_source=lake`, 40 scored

Merged PRs: #344 (ingest + score), #345 (30-day candles).

## What the last snapshot actually showed

Do **not** rediscover this as “listed combo mids are cheap.”

- **0 / 275** lake MVE combos were two-sided. All 40 table rows were
  `no_combo_tape` with combo **bid/ask/last = 0/0/0**.
- `quoteMid(0, 0, 0)` returns **0** (the 0-bid/1-ask empty-book special case
  does not apply). Scorer sets `joint=0` and fires `independence_gap` vs the
  product of the legs. That is RFQ / never traded, **not** a listed misprice.
  Row notes already say RFQ; the verdict headline oversells it.
- **Same-game** examples (Henry 110+ AND Jackson 40+): independence is the
  wrong model even before a combo quote.
- Cross-game NFL stacks have naive products ~13–57¢ and **no combo CLOB**.
- All 40 scored rows were collection `KXMVECROSSCATEGORY-SHARD1-R`: NFL props
  mixed with crypto 15-minute target-price MVEs. Not a clean sportsbook tape.
- Open combos in the table often have **one lake row** (live 0/0/0) and **no
  candles** — they never traded. The 30-day history is mostly on **legs** and
  settled/closed markets. Latest-wins hides that.
- Fed listed + homemade were empty this pass (Kalshi 429). Lake OHLC still:
  BTC×ETH ~0.89, SPY×DIA ~0.84, SPY×CL ~−0.48.

## Analysis to do

1. **Do not treat RFQ 0/0/0 as a combo quote.** Score `independence_gap` /
   implied ρ only when the combo is two-sided inside (0, 1), or use the last
   two-sided / non-zero candle for that ticker — not latest-wins 0¢. If scoring
   changes, bump design to `kalshi-parlays-v4` and cache `kalshi_parlays_v4`.
2. Split **NFL/sports props** vs **crypto 15m MVEs** in `KXMVECROSSCATEGORY`.
   Independence on 15m crypto targets is a different question.
3. Same-game vs cross-game vs mixed (`parlayGameGroup`). For two-leg same-game,
   bound the fair joint with Fréchet and lake-leg mids without a combo tape.
4. Use history properly: for each combo ticker, candles / earlier `fetched_at`
   where `yes_bid > 0` and `yes_ask < 1`. Compare that mid to the product of
   **same-timestamp** (or nearest) leg candles. Latest-wins combo vs
   latest-wins legs at different times is garbage.
5. Report: how many combos ever had a two-sided book in the 30d window;
   distribution of gap vs independence **conditional on a real tape**;
   same-game share; whether anything survives spread + fees.

Hard rule from repo AGENTS.md: no workaround filters that hide bad rows. If
0/0/0 is not a quote, fix `quoteMid` / sports scoring. If crypto MVEs should
not be “sports parlays,” fix the candidate filter or split them in the
notebook — don’t just hide tickers in the UI.

## How to query

```sql
-- sports / MVE
SELECT * FROM options.kalshi_markets
WHERE theme = 'sports' OR category LIKE 'mve|%'

-- combos
WHERE category LIKE 'mve|%'

-- last two-sided snapshot per ticker (what the notebook should score)
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY market_ticker
    ORDER BY fetched_at DESC, run_id DESC
  ) rn
  FROM options.kalshi_markets
  WHERE category LIKE 'mve|%'
    AND yes_bid > 0 AND yes_ask < 1 AND yes_ask >= yes_bid
) WHERE rn = 1
```

- Public snapshot: `GET /api/experiments/kalshi-parlays`
- SQL: `POST /api/query`
- Job: `GET https://cboe-to-r2.robertlancer.workers.dev/jobs/kalshi-markets-hourly`
- Force ingest (human machine with secrets):
  `gh workflow run "Force loader pass (market-closed override)" -f job=kalshi-markets-hourly -f passes=1`
- Do not parallel-hammer Kalshi. Cursor agents get 403 on that workflow
  dispatch; lake + unit tests are the path.

## Code map

- `loader/src/kalshi.ts` — `fetchKalshiSportsParlays`, candles, lookback
- `loader/src/kalshi-mve.ts` — encode/parse `mve|`, `isSportsParlayCandidate`,
  `parlayGameGroup`
- `worker/src/kalshi-parlay.ts` — `quoteMid`, `scoreMultiLegParlay`,
  `KALSHI_PARLAY_DESIGN_ID`
- `worker/src/kalshi-parlay-experiment.ts` — `buildSportsRows`, lake vs live
- `worker/src/index.ts` — sports SQL + cache
- `frontend/src/KalshiParlaysNotebook.tsx`
- Tests: `loader/src/kalshi.test.ts`, `worker/test/kalshi-parlay.test.ts`
