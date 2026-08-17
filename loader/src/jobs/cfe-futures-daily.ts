import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { FuturesEnv } from "../futures.js";
import { cfePassList, publishCfePass } from "../futures.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Cboe Futures Exchange settlements + delayed monthals: batch-scoped, ungated,
// daily. Universe is the two passes ["settlements", "quotes"] so a failure in
// one is recorded without aborting the other (same isolation as fred-econ-daily).
//
// Dry-run: without either Pipeline URL the pass is a no-op.
export function cfeFuturesDailyJob(env: SchedulerEnv): BatchJob {
  return {
    id: "cfe-futures-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "CFE_FUTURES_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => cfePassList(),
    run: async (items, e) => {
      if (!e.PIPELINE_FUTURES_SETTLEMENTS_URL && !e.PIPELINE_FUTURES_QUOTES_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const futuresEnv: FuturesEnv = {
        ...(e as unknown as FuturesEnv),
        runId: () => runId,
      };
      const failures: JobRunFailure[] = [];
      for (const pass of items) {
        // Skip a pass whose pipeline URL is unset (partial provisioning).
        if (pass === "settlements" && !e.PIPELINE_FUTURES_SETTLEMENTS_URL) continue;
        if (pass === "quotes" && !e.PIPELINE_FUTURES_QUOTES_URL) continue;
        try {
          await publishCfePass(pass, futuresEnv);
        } catch (error) {
          failures.push({
            symbol: pass,
            error: String((error && (error as Error).message) || error),
          });
        }
      }
      return { runId, failures };
    },
  };
}
