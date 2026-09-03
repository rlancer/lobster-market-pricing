import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { EarningsEnv } from "../earnings.js";
import { earningsDateForOffset, publishEarningsDate } from "../earnings.js";
import { bundledUniverse, effectiveUniverse } from "../enrolled-universe.js";

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

async function earningsKeepSet(db: D1Database): Promise<Set<string>> {
  const symbols = await effectiveUniverse(db);
  return new Set(symbols.map((s) => s.toUpperCase()));
}

// Earnings calendar: batch-scoped, ungated, daily cadence. Each pass fetches
// the Nasdaq calendar for the next EARNINGS_LOOKAHEAD_DAYS dates (one request
// per date), filters to the effective universe (bundled ∪ enrolled), and
// publishes to options.earnings via the PIPELINE_EARNINGS_URL stream. The lake
// is append-only, so the chat/worker keep the newest run per (symbol,
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
    // Date list is the batch "universe"; KEEP filter is resolved inside run
    // against D1 enrolled_symbols so on-demand tickers are included.
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
      const db = e.LOADER_DB as D1Database | undefined;
      const keep = db
        ? await earningsKeepSet(db)
        : new Set(bundledUniverse().map((s) => s.toUpperCase()));
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const date = items[index];
          try {
            await publishEarningsDate(date, earningsEnv, keep);
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
