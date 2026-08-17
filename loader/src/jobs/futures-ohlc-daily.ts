import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { OhlcEnv } from "../ohlc.js";
import { publishOhlc } from "../ohlc.js";
import futures from "../../symbols/futures.json";

const FUTURES_ROWS: Array<{
  symbol: string;
  name: string;
  asset_class: string;
  exchange: string;
}> = Array.isArray(futures.futures) ? futures.futures : [];

export function futuresOhlcUniverse(): string[] {
  return FUTURES_ROWS.map((f) => f.symbol);
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Continuous Yahoo futures OHLC (=F front month): batch-scoped, ungated, daily.
// Reuses publishOhlc → options.ohlc + options.realized_vol (same pipelines as
// ohlc-daily). Universe is symbols/futures.json — CME/CBOT/NYMEX/COMEX only.
// CFE monthals (VX, …) are handled by cfe-futures-daily.
//
// Dry-run: when neither Pipeline endpoint is configured the pass short-circuits.
export function futuresOhlcDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "FUTURES_OHLC_CONCURRENCY", 4)));
  return {
    id: "futures-ohlc-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "FUTURES_OHLC_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => futuresOhlcUniverse(),
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
