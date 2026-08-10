import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { EconEnv } from "../econ.js";
import { econSourceList, publishEconSource } from "../econ.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Macro / FOMC calendar: batch-scoped, ungated, daily cadence. Each pass syncs
// the full window (FRED allowlisted releases + Fed calendar FOMC/Beige) by
// publishing one source per item, so a per-source failure is recorded without
// aborting the rest — exactly the earnings-daily isolation model.
//
// Dry-run: without PIPELINE_ECON_URL the pass is a no-op (no source fetches,
// no publishes).
export function fredEconDailyJob(env: SchedulerEnv): BatchJob {
  return {
    id: "fred-econ-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "ECON_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => econSourceList(),
    run: async (items, e) => {
      if (!e.PIPELINE_ECON_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const econEnv: EconEnv = {
        ...(e as unknown as EconEnv),
        runId: () => runId,
      };
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const source = items[index];
          try {
            await publishEconSource(source, econEnv);
          } catch (error) {
            failures.push({
              symbol: source,
              error: String((error && (error as Error).message) || error),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(2, items.length) }, () => worker()),
      );
      return { runId, failures };
    },
  };
}