import type { BatchJob, SchedulerEnv } from "../scheduler.js";
import type { KalshiEnv } from "../kalshi.js";
import { parlayExecuteEnabled } from "../kalshi-parlay-filter.js";
import { runKalshiParlayExecutorPass } from "../kalshi-parlay-executor.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Same-game sports parlay RFQ executor. Batch, ungated, 5-minute cadence.
// Default is a no-op: KALSHI_PARLAY_EXECUTE must be "1". Live accepts also
// need KALSHI_PARLAY_LIVE=1. Never the full sports catalog. The hourly
// KXMVE research probe stays separate and never accepts.
export function kalshiParlayExecutorJob(env: SchedulerEnv): BatchJob {
  return {
    id: "kalshi-parlay-executor",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "KALSHI_PARLAY_CADENCE_SECONDS", 300)),
    scope: "batch",
    universe: () => ["KXMVE"],
    run: async (_items, e) => {
      if (!parlayExecuteEnabled(e)) {
        return { runId: null, failures: [] };
      }
      const kalshiEnv: KalshiEnv = { ...(e as unknown as KalshiEnv) };
      try {
        await runKalshiParlayExecutorPass(kalshiEnv);
        return { runId: null, failures: [] };
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
