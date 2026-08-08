import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { OhlcEnv } from "../ohlc.js";
import { publishOhlc } from "../ohlc.js";
import sp500 from "../../symbols/sp500.json";

const SYMBOLS = Array.isArray(sp500.symbols) ? sp500.symbols : [];

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// OHLC + realized-vol enrichment: batch-scoped, ungated (daily), whole S&P 500
// universe. Each symbol is fetched/normalized/published via publishOhlc; the
// job's daily cadence (job_state) governs how often the pass runs.
//
// Dry-run: when neither Pipeline endpoint is configured the pass short-circuits
// to a no-op (no source fetches, no publishes). This keeps local dev and the
// unit suite cheap and matches the "dry-run unless a pipeline URL is set"
// behavior the enrichment plan calls for.
export function ohlcDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "OHLC_CONCURRENCY", 4)));
  return {
    id: "ohlc-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "OHLC_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => SYMBOLS,
    run: async (items, e) => {
      if (!e.PIPELINE_OHLC_URL && !e.PIPELINE_REALIZED_VOL_URL) {
        return { runId: null, failures: [] };
      }
      const ohlcEnv = e as unknown as OhlcEnv;
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishOhlc(symbol, ohlcEnv);
          } catch (error) {
            failures.push({
              symbol,
              error: String((error && (error as Error).message) || error),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
      );
      return { runId: null, failures };
    },
  };
}
