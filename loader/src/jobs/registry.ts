import type { JobSpec, SchedulerEnv } from "../scheduler.js";
import { cboeOptionsJob } from "./cboe-options.js";
import { ohlcDailyJob } from "./ohlc-daily.js";

// Job registry — the single place to add an ETL job. Each entry is a
// self-contained JobSpec (scope, cadence, market-gate policy, handler). The
// scheduler polls `job_state` and dispatches through these.
//
// Phase 2 registers:
//   - cboe-options — item-scoped, market-gated, continuous cadence, item store
//     `symbol_state` (wraps runSymbols).
//   - ohlc-daily   — batch, ungated, daily cadence, whole S&P 500 universe
//     (wraps publishOhlc).
export function buildJobs(env: SchedulerEnv): JobSpec[] {
  return [
    cboeOptionsJob(env),
    ohlcDailyJob(env),
  ];
}
