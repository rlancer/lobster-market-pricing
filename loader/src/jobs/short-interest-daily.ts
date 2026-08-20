import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { ShortInterestEnv } from "../short-interest.js";
import {
  SHORT_INTEREST_LOOKBACK_MONTHS_DEFAULT,
  publishShortInterestDate,
  shortInterestSettlementCandidates,
} from "../short-interest.js";
import { bundledUniverse, effectiveUniverse } from "../enrolled-universe.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

async function shortInterestKeepSet(db: D1Database): Promise<Set<string>> {
  const symbols = await effectiveUniverse(db);
  return new Set(symbols.map((s) => s.toUpperCase()));
}

// FINRA consolidated short interest: batch-scoped, ungated, daily cadence.
// Each pass walks candidate mid-month / month-end settlement dates for the
// last SHORT_INTEREST_LOOKBACK_MONTHS (default 3), pages the FINRA API, filters
// to the effective universe (bundled ∪ enrolled), and publishes to
// options.short_interest via PIPELINE_SHORT_INTEREST_URL. Unpublished /
// non-settlement dates (HTTP 204) are skipped, not failures — FINRA only
// publishes ~twice a month, on the 7th business day after settlement.
//
// Dry-run: without PIPELINE_SHORT_INTEREST_URL the pass is a no-op.
export function shortInterestDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "SHORT_INTEREST_CONCURRENCY", 2)));
  const lookback = Math.max(
    1,
    Math.floor(num(env, "SHORT_INTEREST_LOOKBACK_MONTHS", SHORT_INTEREST_LOOKBACK_MONTHS_DEFAULT)),
  );
  return {
    id: "short-interest-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "SHORT_INTEREST_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => shortInterestSettlementCandidates(Date.now(), lookback),
    run: async (items, e) => {
      if (!e.PIPELINE_SHORT_INTEREST_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const siEnv: ShortInterestEnv = {
        ...(e as unknown as ShortInterestEnv),
        runId: () => runId,
      };
      const db = e.LOADER_DB as D1Database | undefined;
      const keep = db
        ? await shortInterestKeepSet(db)
        : new Set(bundledUniverse().map((s) => s.toUpperCase()));
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const date = items[index];
          try {
            await publishShortInterestDate(date, siEnv, keep);
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
