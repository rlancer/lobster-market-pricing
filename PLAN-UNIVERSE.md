# Expanding the universe: major ETFs + Nasdaq-100 delta

Exploration for adding symbols beyond the S&P 500. Goal (from the ask): cover
the stocks in the major indexes and the major ETFs — **not** the whole market.

## What's already covered

- **S&P 500** — `symbols/sp500.json`, 503 symbols. The loader runs over this.
- **Dow Jones 30** — a strict subset of the S&P 500 (verified 2026-08-09: all 30
  Dow members are present in the 503). The Dow adds **zero** new symbols and is
  excluded from the plan.
- **Russell 1000/3000** — deliberately excluded ("we don't need the whole universe").

## The actual gap

**Nasdaq-100** has 15 members outside the S&P 500 (fetched live from Nasdaq's
official API, 2026-08-09):

| Ticker | Company | Sector |
| ------ | ------- | ------ |
| ASML | ASML Holding N.V. | Information Technology |
| MSTR | Strategy (MicroStrategy) | Information Technology |
| ARM | Arm Holdings | Information Technology |
| SHOP | Shopify | Information Technology |
| ALAB | Astera Labs | Information Technology |
| CRWV | CoreWeave | Information Technology |
| NBIS | Nebius Group | Information Technology |
| MELI | MercadoLibre | Consumer Discretionary |
| PDD | PDD Holdings | Consumer Discretionary |
| RKLB | Rocket Lab | Industrials |
| SPCX | SpaceX | Industrials |
| TRI | Thomson Reuters | Industrials |
| FER | Ferrovial | Industrials |
| ALNY | Alnylam Pharmaceuticals | Health Care |
| CCEP | Coca-Cola Europacific Partners | Consumer Staples |

Plus **65 major ETFs** (curated — there is no canonical free "major ETFs" list):
broad-market (SPY, IVV, VOO, VTI, QQQ, QQQM, DIA, IWM, MDY, IJR, SPYG, VUG,
VIG, SCHD, IWB), sector SPDRs (XLE/XLK/XLF/XLV/XLI/XLP/XLY/XLU/XLB/XLRE/XLC),
international (EFA, EEM, VEA, VWO, ACWI, FXI, EWZ, EWG, EWP, EWJ, KWEB),
fixed income (TLT, IEF, AGG, BND, LQD, HYG, JNK, SHY, MUB, TIP), commodities
(GLD, IAU, SLV, USO, DBB, DBA, UNG), real estate (IYR, VNQ), thematic (SMH,
SOXX, XBI, IGV, ARKK), leveraged (TQQQ, UPRO, SOXL, SQQQ).

**New universe: 503 + 15 + 65 = 583 symbols.**

## Feasibility: CBOE serves every one of them

All 15 NDX-late tickers and all 65 ETFs were probed against the exact endpoint
the loader uses (`https://cdn.cboe.com/api/global/delayed_quotes/options/{sym}.json`).
Every one returns HTTP 200 with a live option chain (sample: SPY 14,572 contracts,
QQQ 12,854, GLD 7,382, ASML 6,862, MSTR 3,092, ARM 2,552, SHOP 1,862). CBOE's
free delayed-quotes feed does **not** serve option chains for IYM/XRT/IBB/QQQE —
those are excluded from the ETF manifest.

## Reusable ticker-grab (the deliverable)

The refresh is a documented, rerunnable script — **`loader/tools/refresh_universe.py`** —
so adding/removing symbols as indexes change is a one-liner, not archaeology:

```powershell
cd loader
python tools/refresh_universe.py --probe-cboe   # ~2.5 min; probes are rate-limited by design
```

- **Nasdaq-100** is fetched **live** from Nasdaq's official API
  (`https://api.nasdaq.com/api/quote/list-type/nasdaq100?assetclass=stocks`),
  with a pinned fallback if the API is down.
- **S&P 500** is read from the existing `sp500.json` / `sp500_constituents.json`.
- **ETFs** come from the curated `symbols/etfs.json` (hand-maintained; edit it
  to change ETF coverage).
- Output: **`symbols/universe.json`** — `symbols: string[]` (same shape the
  loader reads today) plus a `constituents` symbol→{name, sector, source} map
  (`source` ∈ `sp500` | `nasdaq100` | `etf`) for enrichment. Deterministic,
  sorted, deduped, atomic write.
- `--probe-cboe` validates each new symbol has a CBOE chain, retrying past
  429/5xx rate limits. A flag is **advisory** — rate limiting can false-negative
  a single symbol (ACWI was flagged once, confirmed served on a manual retry);
  confirm before dropping.

## Loader wiring (not yet done — next step)

Today all four jobs read `symbols/sp500.json` directly and `run-symbols.ts`
enriches from `sp500_constituents.json`. To actually consume the 583-symbol
universe:

1. Switch `jobs/cboe-options.ts`, `jobs/ohlc-daily.ts`, `jobs/ohlc-backfill.ts`,
   `jobs/earnings-daily.ts` to import `universe.json` (its `symbols` array is
   source-compatible) instead of `sp500.json`.
2. Point `run-symbols.ts`'s enrichment map at `universe.json`'s `constituents`
   (so NDX-late/ETF names + sectors land on `underlying_snapshots` instead of
   falling back to `Unknown`).
3. `earnings-daily` keeps working unchanged — ETFs just produce no earnings rows.
4. **No `MAX_SYMBOLS` change needed**: the 503 cap is enforced per-`runSymbols`
   *batch* (capped by `LOADER_BATCH_SIZE`), not across the universe.

## Impact estimate

- **Contracts per pass**: +80 symbols of CBOE chains. The long-$OPTION chains
  (SPY/QQQ ~13–15k contracts each) add meaningfully to the ~1M contract figure;
  the 15 NDX-late names are modest. Lake volume grows proportionally.
- **Load cadence**: `cboe-options` is item-scoped and batch-capped, so +80 items
  just extends the continuous loop's cycle time; `ohlc-daily` +80 Yahoo fetches/day.
- **Frontend**: the sector filter and typeahead already read the lake dynamically;
  the new ETF asset-class "sectors" (Broad Market, Fixed Income, Commodities, …)
  will appear as filter options. Hardcoded "S&P 500" copy in `Docs.tsx`,
  `AiChat.tsx`, `Notebooks.tsx`, and the html title should be softened to "US
  equities + ETFs" if the product is rebranded.

## Risks / notes

- Leveraged ETFs (TQQQ/SOQL/SQQQ/UPRO) are intentional — they're among the
  highest options-volume names — but they are high-vol and a few extra data rows;
  drop them from `etfs.json` if not wanted.
- `SPCX` (SpaceX) entered NDX in 2026; if it's excluded from CBOE's delayed feed
  at deploy time the probe will flag it and it can be dropped from the manifest.
- Universe refresh is a manual, documented step (quarterly is plenty) — not yet
  scheduled. Index-membership drift between refreshes is expected and harmless.