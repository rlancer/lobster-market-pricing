import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { KalshiEnv } from "../kalshi.js";
import { kalshiSeriesList, publishKalshiSeries } from "../kalshi.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Curated Kalshi event contracts: batch-scoped, ungated, hourly cadence.
// Prediction markets trade nearly 24/7 — hourly snapshots keep Fed/CPI/index
// odds fresh for Copilot event-vol context and future Kalshi trade suggestions
// without ingesting the full sports/entertainment catalog.
//
// Each pass syncs one series_ticker from symbols/kalshi-series.json so a
// per-series failure is recorded without aborting the rest.
//
// Dry-run: without PIPELINE_KALSHI_MARKETS_URL the pass is a no-op.
export function kalshiMarketsHourlyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "KALSHI_CONCURRENCY", 1)));
  return {
    id: "kalshi-markets-hourly",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "KALSHI_CADENCE_SECONDS", 3600)),
    scope: "batch",
    universe: () => kalshiSeriesList(),
    run: async (items, e) => {
      if (!e.PIPELINE_KALSHI_MARKETS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const kalshiEnv: KalshiEnv = {
        ...(e as unknown as KalshiEnv),
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
            await publishKalshiSeries(seriesId, kalshiEnv);
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
