import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { EarningsEnv } from "../earnings.js";
import { earningsDateForOffset, publishEarningsDate } from "../earnings.js";
import universe from "../../symbols/universe.json";

const SYMBOLS = Array.isArray(universe.symbols) ? universe.symbols : [];
// The Nasdaq calendar covers the whole market; the lake's universe is the merged
// manifest (S&P 500 + Nasdaq-100 + ETFs), so only universe symbols are kept at
// publish time. ETFs have no earnings, so they simply never match the calendar.
const KEEP = new Set(SYMBOLS.map((s) => s.toUpperCase()));

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// How many calendar days ahead each pass syncs (today + lookahead-1). Exported
// for tests.
export const EARNINGS_LOOKAHEAD_DAYS = 14;

export function earningsDateList(now: number, lookahead = EARNINGS_LOOKAHEAD_DAYS): string[] {
  return Array.from({ length: lookahead }, (_, i) => earningsDateForOffset(now, i));
}

// Earnings calendar: batch-scoped, ungated, daily cadence. Each pass fetches
// the Nasdaq calendar for the next EARNINGS_LOOKAHEAD_DAYS dates (one request
// per date), filters to the S&P 500 manifest, and publishes to
// options.earnings via the PIPELINE_EARNINGS_URL stream. The lake is
// append-only, so the Copilot/worker keep the newest run per (symbol,
// earnings_date) with QUALIFY — exactly the ohlc pattern.
//
// Dry-run: without PIPELINE_EARNINGS_URL the pass is a no-op (no source
// fetches, no publishes).
export function earningsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "EARNINGS_CONCURRENCY", 3)));
  return {
    id: "earnings-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "EARNINGS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => earningsDateList(Date.now()),
    run: async (items, e) => {
      if (!e.PIPELINE_EARNINGS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const earningsEnv: EarningsEnv = {
        ...(e as unknown as EarningsEnv),
        runId: () => runId,
      };
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const date = items[index];
          try {
            await publishEarningsDate(date, earningsEnv, KEEP);
          } catch (error) {
            failures.push({
              symbol: date,
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