import type { JobSpec, SchedulerEnv } from "../scheduler.js";
import { cboeOptionsJob } from "./cboe-options.js";
import { ohlcDailyJob } from "./ohlc-daily.js";
import { ohlcBackfillJob } from "./ohlc-backfill.js";
import { earningsDailyJob } from "./earnings-daily.js";
import { fredEconDailyJob } from "./fred-econ-daily.js";
import { etfDailyJob } from "./etf-daily.js";
import { fundamentalsDailyJob } from "./fundamentals-daily.js";

// Job registry — the single place to add an ETL job. Each entry is a
// self-contained JobSpec (scope, cadence, market-gate policy, handler). The
// scheduler polls `job_state` and dispatches through these.
//
// Phase 2 registers:
//   - cboe-options    — item-scoped, market-gated, continuous cadence, item
//     store `symbol_state` (wraps runSymbols).
//   - ohlc-daily      — batch, ungated, daily cadence, whole merged universe
//     (S&P 500 + Nasdaq-100 + ETFs) (wraps publishOhlc).
//   - ohlc-backfill   — item-scoped, resumable 2y backfill (manual trigger).
//   - earnings-daily  — batch, ungated, daily cadence; ~2-week Nasdaq
//     earnings-calendar window filtered to the merged universe
//     (wraps publishEarningsDate).
//   - etf-daily       — batch, ungated, daily cadence; Yahoo fundProfile +
//     topHoldings for symbols/etfs.json → options.etf_profiles / etf_holdings.
//   - fundamentals-daily — batch, ungated, daily cadence; Yahoo quoteSummary
//     equity fundamentals → options.fundamentals (latest-wins by ticker).
export function buildJobs(env: SchedulerEnv): JobSpec[] {
  return [
    cboeOptionsJob(env),
    ohlcDailyJob(env),
    ohlcBackfillJob(env),
    earningsDailyJob(env),
    fredEconDailyJob(env),
    etfDailyJob(env),
    fundamentalsDailyJob(env),
  ];
}
