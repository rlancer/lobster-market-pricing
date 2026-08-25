import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { MacroEnv } from "../macro.js";
import { publishMacroSeries, macroSeriesList } from "../macro.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// FRED inflation / price indexes: batch-scoped, ungated, daily cadence. Each
// pass syncs the curated CPI/PCE/PPI allowlist one series at a time so a
// per-series failure is recorded without aborting the rest — same isolation
// model as fred-yields-daily / fred-econ-daily.
//
// Dry-run: without PIPELINE_MACRO_URL the pass is a no-op (no source fetches,
// no publishes).
export function fredMacroDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "MACRO_CONCURRENCY", 2)));
  return {
    id: "fred-macro-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "MACRO_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => macroSeriesList(),
    run: async (items, e) => {
      if (!e.PIPELINE_MACRO_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const macroEnv: MacroEnv = {
        ...(e as unknown as MacroEnv),
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
            await publishMacroSeries(seriesId, macroEnv);
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
