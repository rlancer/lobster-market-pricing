# Data Lake Enrichment — Free Data Sources

Brainstorm + plan for enriching the `options-db` data lake (Cloudflare R2 Iceberg)
with additional free data. Current lake: `options.option_contracts` (strikes, greeks,
bid/ask/last, volume/OI, expiration), `options.underlyings` (symbol, spot, name, sector),
`options.refresh_runs`.

Everything below is grounded in what the lake already has and what actually improves an
options screener. Each source is scored on: source, free-status, licensing, and how it
maps into the existing Pipeline → R2 Iceberg pattern.

**Licensing is the real constraint, not availability.** EDGAR, FRED, Treasury, CBOE, and
FINRA are official and redistributable — safe to land in the lake and serve commercially.
Stooq/Yahoo are fine for personal use but should not be exposed through `/api/query` to
third parties.

---

## Tier 1 — directly improves screening economics (highest ROI)

### 1. Historical daily OHLC (per underlying)
Biggest win. Unlocks:
- **Realized volatility** → `IV / realized vol` ratio. The single most valuable
  screening metric (which premiums are cheap vs. expensive). CBOE's snapshot greeks
  alone can't tell you this.
- Historical moneyness, 52-week range context, drawdown state.
- Later: option backtesting.

| Source | Free status | License / caveat |
|---|---|---|
| **Stooq** (CSV, per-symbol, full history) | free | Non-commercial only; do **not** redistribute/serve commercially. Easiest bulk fetch (http→CSV). |
| **Yahoo Finance** (unofficial API) | free | ToS-gray for commercial caching/redistribution. Fine for a personal screener. |
| **Alpha Vantage** | free key | Free tier cut to ~**25 req/day** — not viable for 500+ symbols. Skip the universe, OK for a handful. |
| **Tiingo** | free tier (key) | Limited to a small symbol set on free. |

### 2. Dividends + splits / ex-dividend dates
Matters for options because dividend expectancy affects pricing (put–call parity,
early exercise) and IV near ex-div.
- **SEC EDGAR `companyfacts`** — structured XBRL: cash dividends
  (`us-gaap:PaymentsOfDividends`), splits (`StockSplits`), shares outstanding.
  Official, public-domain, redistributable. Best source overall.
- **Nasdaq dividend history** — free CSV/JSON per symbol.
- **yfinance** dividend history as a fallback (license gray).

### 3. Risk-free rate
Greeks are sensitive to it; roll your own rather than trusting only CBOE's baked-in
values. Near-free.
- **FRED** (`DGS3MO`, `DGS10`) — free API (key required, no cost), official, redistributable.
- **Treasury Direct** par-yield API — public domain.

### 4. Realized volatility
*Derived* from #1, not a source. Compute in the loader and store as its own
column/table so screens can join it without recomputing.

---

## Tier 2 — event awareness (high value for options specifically)

### 5. Earnings dates & results
Classic options edge: IV is elevated into earnings and crushes after. Knowing the next
earnings date enables "cheap relative to its own earnings-IV bubble" screening.
- **SEC EDGAR** `submissions` API (8-K/10-Q schedule) — official.
- **FMP free tier** earnings calendar (key; limited).
- Note: no fully-free high-quality earnings-calendar dataset; EDGAR-derived is the
  honest option.

### 6. VIX / market regime
Cheap context to bucket screens by volatility regime.
- **CBOE VIX** historical CSV/JSON — free, official (already using CBOE).

---

## Tier 3 — fundamentals / securities master from filings

### 7. SEC EDGAR fundamentals
`companyfacts` → shares outstanding, market cap, revenue, float;
`company_tickers.json` → **CIK↔ticker** map to join against `underlyings`. Turns a thin
ticker row into a proper security master. Official + redistributable (public domain).
Mind the rate limit (~10 req/s; use a User-Agent header — same pattern already used
for CBOE).

### 8. Constituent membership
Already using the Wikipedia S&P 500 manifest. Add a history of membership *changes* for
survivorship-accurate backtests later.

---

## Optional Tier 4

### 9. Short interest
FINRA publishes official, free, redistributable short-sale disclosure data (bi-monthly)
per symbol. Sentiment signal alongside options flow.

### 10. News / headlines
GDELT (free, bulk) or plain RSS; low signal-per-effort and licensing/quality is poor.
Skip unless the AI copilot needs them.

---

## Integration notes (given current stack)

- Each source becomes a new **Pipeline → Iceberg table** following the existing
  `option_contracts` / `underlyings` pattern: fetch in the `cboe-to-r2` loader (or a
  sibling loader Worker), normalize, publish with idempotency keys, expose read-only via
  `/api/query`.
- **Schedule reality check:** SEC EDGAR and FRED update slowly (daily/quarterly) — a
  **daily** pass is plenty, unlike CBOE's 15-min cadence. Give these their own cadence,
  not the continuous per-symbol loop.

## Recommended order of attack

1. **OHLC** (Stooq or yfinance) → realized vol, IV/realized ratio. Biggest screener upgrade.
2. **Dividends/ex-div** + **risk-free rate** → correct the pricing model. EDGAR
   `companyfacts` covers all three plus the securities-master fields.
3. **Earnings dates** → IV-crush-aware screening.
4. Everything else is nice-to-have.

## Prototype status

- [x] OHLC + realized-vol pipeline (`options.ohlc`, `options.realized_vol`) — `loader/src/ohlc.ts`, schemas, tests, `loader/tools/ohlc_probe.ts`. Source: **Yahoo v8 chart API** (Stooq CSV rejected — behind a JS proof-of-work challenge, returns HTML not data). 30d/90d realized vol from log returns, annualized ×√252. Verified: 7 unit tests (incl. exact-value cross-check) + live probe = 251 daily bars/symbol.
- [x] ETL scheduler foundation (`EtlScheduler`) — `loader/src/scheduler.ts` + job registry (`jobs/registry.ts`). Registered jobs: `cboe-options` (continuous, market-gated, item store `symbol_state`) and `ohlc-daily` (daily, ungated, whole S&P 500 universe, dry-run no-op until a Pipeline URL is set). Schedule ledger `job_state` (migration 0002).
- [x] Wire `ohlc-daily` into the scheduler (`jobs/ohlc-daily.ts`): whole S&P 500 universe, daily cadence, ungated. Dry-run (no Pipeline URL) short-circuits to a no-op pass; with `PIPELINE_OHLC_URL`/`PIPELINE_REALIZED_VOL_URL` configured it fetches + normalizes + publishes per symbol (bounded concurrency; per-symbol failures collected, don't abort the batch). Verified: `src/jobs/ohlc-daily.test.ts` (dry-run no-op, publish end-to-end, per-symbol failure isolation) + dry-run `pass_completed` in `wrangler dev`.
- [x] Provision `options.ohlc` / `options.realized_vol` Pipeline tables: streams `cboe_ohlc_v2`/`cboe_realized_vol_v2`, sinks `cboe_ohlc_sink`/`cboe_realized_vol_sink` (R2 Data Catalog → bucket `cboe-options-data`), pipelines wired. Ingest verified end-to-end (POST → committed → queryable via R2 SQL). `PIPELINE_OHLC_URL`/`PIPELINE_REALIZED_VOL_URL` and `PIPELINE_AUTH_TOKEN` set as Worker secrets; `R2_DATA_CATALOG_TOKEN` + `PIPELINE_AUTH_TOKEN` stored in GitHub secrets.
- [ ] Dividends / ex-div (EDGAR `companyfacts`)
- [ ] Risk-free rate (FRED / Treasury)
- [ ] Earnings dates
