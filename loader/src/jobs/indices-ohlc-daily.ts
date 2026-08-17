import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { OhlcEnv } from "../ohlc.js";
import { publishOhlc } from "../ohlc.js";
import indices from "../../symbols/indices.json";

const INDEX_ROWS: Array<{
  symbol: string;
  name: string;
  family: string;
  cboe_quote: string;
}> = Array.isArray(indices.indices) ? indices.indices : [];

export function indicesOhlcUniverse(): string[] {
  return INDEX_ROWS.map((i) => i.symbol);
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// CBOE volatility-index OHLC (^VIX, ^VVIX, …): batch-scoped, ungated, daily.
// Reuses publishOhlc → options.ohlc + options.realized_vol (same pipelines as
// ohlc-daily / futures-ohlc-daily). Universe is symbols/indices.json — not
// part of the equity/ETF option-chain universe (index options use a different
// CBOE root and are out of scope here). VX futures land via cfe-futures-daily.
//
// Dry-run: when neither Pipeline endpoint is configured the pass short-circuits.
export function indicesOhlcDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "INDICES_OHLC_CONCURRENCY", 4)));
  return {
    id: "indices-ohlc-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "INDICES_OHLC_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => indicesOhlcUniverse(),
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
