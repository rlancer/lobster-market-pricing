import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { OhlcEnv } from "../ohlc.js";
import { publishOhlc } from "../ohlc.js";
import cryptoSpot from "../../symbols/crypto-spot.json";

const CRYPTO_ROWS: Array<{
  symbol: string;
  name: string;
  asset_class: string;
}> = Array.isArray(cryptoSpot.cryptos) ? cryptoSpot.cryptos : [];

export function cryptoSpotOhlcUniverse(): string[] {
  return CRYPTO_ROWS.map((c) => c.symbol);
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Spot cryptocurrency OHLC (BTC-USD, ETH-USD, …): batch-scoped, ungated, daily.
// Reuses publishOhlc → options.ohlc + options.realized_vol (same pipelines as
// ohlc-daily / futures-ohlc-daily / indices-ohlc-daily). Universe is
// symbols/crypto-spot.json — not part of the equity/ETF option-chain universe
// (spot crypto has no OCC root on the CBOE delayed feed). Crypto ETFs with
// option chains live in etfs.json; CME continuous futures stay in futures.json.
//
// Dry-run: when neither Pipeline endpoint is configured the pass short-circuits.
export function cryptoSpotOhlcDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "CRYPTO_SPOT_OHLC_CONCURRENCY", 4)));
  return {
    id: "crypto-spot-ohlc-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "CRYPTO_SPOT_OHLC_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => cryptoSpotOhlcUniverse(),
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
