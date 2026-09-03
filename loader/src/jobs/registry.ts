import type { JobSpec, SchedulerEnv } from "../scheduler.js";
import { cboeOptionsJob } from "./cboe-options.js";
import { ohlcDailyJob } from "./ohlc-daily.js";
import { ohlcBackfillJob } from "./ohlc-backfill.js";
import { earningsDailyJob } from "./earnings-daily.js";
import { fredEconDailyJob } from "./fred-econ-daily.js";
import { etfDailyJob } from "./etf-daily.js";
import { fundamentalsDailyJob } from "./fundamentals-daily.js";
import { futuresOhlcDailyJob } from "./futures-ohlc-daily.js";
import { cfeFuturesDailyJob } from "./cfe-futures-daily.js";
import { indicesOhlcDailyJob } from "./indices-ohlc-daily.js";
import { cryptoSpotOhlcDailyJob } from "./crypto-spot-ohlc-daily.js";
import { researchBriefsDailyJob } from "./research-briefs-daily.js";
import { shortInterestDailyJob } from "./short-interest-daily.js";
import { regShoDailyJob } from "./reg-sho-daily.js";
import { secFilingsDailyJob } from "./sec-filings-daily.js";
import { instrumentsDailyJob } from "./instruments-daily.js";
import { fredYieldsDailyJob } from "./fred-yields-daily.js";
import { fredMacroDailyJob } from "./fred-macro-daily.js";
import { kalshiMarketsHourlyJob } from "./kalshi-markets-hourly.js";
import { earningsResultsDailyJob } from "./earnings-results-daily.js";
import { companyFactsDailyJob } from "./company-facts-daily.js";

// Job registry — the single place to add an ETL job. Each entry is a
// self-contained JobSpec (scope, cadence, market-gate policy, handler). The
// scheduler polls `job_state` and dispatches through these.
//
// Phase 2 registers:
//   - cboe-options    — item-scoped, market-gated, continuous cadence, item
//     store `symbol_state` (wraps runSymbols).
//   - ohlc-daily      — batch, ungated, daily cadence, effective universe
//     (bundled manifest ∪ enrolled_symbols) (wraps publishOhlc).
//   - ohlc-backfill   — item-scoped, resumable 2y backfill (manual trigger).
//   - earnings-daily  — batch, ungated, daily cadence; ~2-week Nasdaq
//     earnings-calendar window filtered to the merged universe
//     (wraps publishEarningsDate).
//   - earnings-results-daily — batch, ungated, daily; Yahoo earningsHistory
//     actual vs estimate → options.earnings_results.
//   - company-facts-daily — batch, ungated, daily; SEC companyfacts XBRL
//     (SBC, debt, NI, OCF, …) → options.company_facts.
//   - etf-daily       — batch, ungated, daily cadence; Yahoo fundProfile +
//     topHoldings for symbols/etfs.json ∪ enrolled ETFs → options.etf_profiles / etf_holdings.
//   - fundamentals-daily — batch, ungated, daily cadence; Yahoo quoteSummary
//     equity fundamentals → options.fundamentals (latest-wins by ticker).
//   - futures-ohlc-daily — batch, ungated, daily; Yahoo continuous futures
//     (=F) from symbols/futures.json → options.ohlc / realized_vol.
//   - cfe-futures-daily — batch, ungated, daily; CBOE CFE settlement CSV +
//     delayed monthals → options.futures_settlements / futures_quotes.
//   - indices-ohlc-daily — batch, ungated, daily; Yahoo CBOE vol indexes
//     (^VIX, …) from symbols/indices.json → options.ohlc / realized_vol.
//   - crypto-spot-ohlc-daily — batch, ungated, daily; Yahoo spot crypto
//     (BTC-USD, …) from symbols/crypto-spot.json → options.ohlc / realized_vol.
//   - short-interest-daily — batch, ungated, daily; FINRA consolidated equity
//     short interest (bi-monthly settlement dates) → options.short_interest.
//   - reg-sho-daily — batch, ungated, daily; FINRA Reg SHO short-sale volume
//     (facility rollup → short_ratio) → options.reg_sho_daily.
//   - research-briefs-daily — item-scoped, ungated, daily; warms API Worker
//     D1 `ticker_research` via POST /api/research/warm (no new lake table).
//   - sec-filings-daily — batch, ungated, daily; SEC EDGAR submissions →
//     options.sec_filings (equity 10-K/Q/8-K + ETF prospectus family).
//   - instruments-daily — batch, ungated, daily; manifest classification →
//     options.instruments (security_type equity|etf|index|future|crypto).
//   - fred-yields-daily — batch, ungated, daily; FRED Treasury / rates curve
//     observations → options.yields (DGS* + spreads + TIPS/breakevens +
//     T5YIFR forward + DFF/SOFR).
//   - fred-macro-daily — batch, ungated, daily; FRED CPI/PCE/PPI index + YoY
//     observations → options.macro (realized inflation levels; calendar dates
//     stay on options.econ_calendar).
//   - kalshi-markets-hourly — batch, ungated, hourly; curated Kalshi event
//     contracts (Fed/CPI/indexes/crypto/oil) → options.kalshi_markets.
export function buildJobs(env: SchedulerEnv): JobSpec[] {
  return [
    cboeOptionsJob(env),
    ohlcDailyJob(env),
    ohlcBackfillJob(env),
    earningsDailyJob(env),
    earningsResultsDailyJob(env),
    companyFactsDailyJob(env),
    fredEconDailyJob(env),
    etfDailyJob(env),
    fundamentalsDailyJob(env),
    futuresOhlcDailyJob(env),
    cfeFuturesDailyJob(env),
    indicesOhlcDailyJob(env),
    cryptoSpotOhlcDailyJob(env),
    shortInterestDailyJob(env),
    regShoDailyJob(env),
    researchBriefsDailyJob(env),
    secFilingsDailyJob(env),
    instrumentsDailyJob(env),
    fredYieldsDailyJob(env),
    fredMacroDailyJob(env),
    kalshiMarketsHourlyJob(env),
  ];
}
