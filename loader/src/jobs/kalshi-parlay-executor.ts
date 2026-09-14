import type { BatchJob, SchedulerEnv } from "../scheduler.js";
import type { KalshiEnv } from "../kalshi.js";
import { parlayExecuteEnabled, parlayLiveEnabled, parlayMaxAcceptsPerPass } from "../kalshi-parlay-filter.js";
import { rfqContracts } from "../kalshi-rfq-quotes.js";
import {
  emptyParlayPass,
  parlayExecutorPassDetail,
  runKalshiParlayExecutorPass,
} from "../kalshi-parlay-executor.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sizeFlags(env: SchedulerEnv): { contracts: number; max_accepts_per_pass: number } {
  return {
    contracts: rfqContracts(env as unknown as KalshiEnv),
    max_accepts_per_pass: parlayMaxAcceptsPerPass(env),
  };
}

function idleDetail(env: SchedulerEnv): Record<string, unknown> {
  return parlayExecutorPassDetail(
    emptyParlayPass("execute_off"),
    { execute: false, live: parlayLiveEnabled(env), ...sizeFlags(env) },
  );
}

// Same-game sports parlay RFQ executor. Batch, ungated, 5-minute cadence.
// Live: KALSHI_PARLAY_EXECUTE=1 and KALSHI_PARLAY_LIVE=1, 10 contracts
// ($10 notional), at most one accept per pass. Never the full sports catalog.
// The hourly KXMVE research probe stays separate and never accepts.
export function kalshiParlayExecutorJob(env: SchedulerEnv): BatchJob {
  return {
    id: "kalshi-parlay-executor",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "KALSHI_PARLAY_CADENCE_SECONDS", 300)),
    scope: "batch",
    universe: () => ["KXMVE"],
    run: async (_items, e) => {
      if (!parlayExecuteEnabled(e)) {
        return { runId: null, failures: [], detail: idleDetail(e) };
      }
      const kalshiEnv: KalshiEnv = { ...(e as unknown as KalshiEnv) };
      try {
        const pass = await runKalshiParlayExecutorPass(kalshiEnv);
        return {
          runId: null,
          failures: [],
          detail: parlayExecutorPassDetail(pass, {
            execute: true,
            live: parlayLiveEnabled(e),
            ...sizeFlags(e),
          }),
        };
      } catch (error) {
        return {
          runId: null,
          failures: [{
            symbol: "KXMVE",
            error: String((error && (error as Error).message) || error),
          }],
        };
      }
    },
  };
}
