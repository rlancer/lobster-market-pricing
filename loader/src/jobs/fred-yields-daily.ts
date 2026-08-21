import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { YieldsEnv } from "../yields.js";
import { publishYieldSeries, yieldsSeriesList } from "../yields.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// US Treasury / rates curve: batch-scoped, ungated, daily cadence. Each pass
// syncs the curated FRED series allowlist (constant-maturity Treasuries,
// spreads, TIPS/breakevens, overnight policy) one series at a time so a
// per-series failure is recorded without aborting the rest — same isolation
// model as fred-econ-daily / earnings-daily.
//
// Dry-run: without PIPELINE_YIELDS_URL the pass is a no-op (no source fetches,
// no publishes).
export function fredYieldsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "YIELDS_CONCURRENCY", 2)));
  return {
    id: "fred-yields-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "YIELDS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => yieldsSeriesList(),
    run: async (items, e) => {
      if (!e.PIPELINE_YIELDS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const yieldsEnv: YieldsEnv = {
        ...(e as unknown as YieldsEnv),
        runId: () => runId,
      };
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const seriesId = items[index];
          try {
            await publishYieldSeries(seriesId, yieldsEnv);
          } catch (error) {
            failures.push({
              symbol: seriesId,
              error: String((error && (error as Error).message) || error),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
      );
      return { runId, failures };
    },
  };
}
