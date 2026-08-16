import type { BatchJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { FundamentalsEnv } from "../fundamentals.js";
import { openYahooSession } from "../etf.js";
import { publishFundamentals } from "../fundamentals.js";
import universe from "../../symbols/universe.json";

type Constituent = { name?: string; sector?: string; source?: string };

const CONSTITUENTS: Record<string, Constituent> =
  universe && typeof universe === "object" && "constituents" in universe
    ? (universe.constituents as Record<string, Constituent>)
    : {};

/** Equity sleeve of universe.json (S&P 500 + Nasdaq-100 delta) — no ETFs. */
export function fundamentalsUniverse(): string[] {
  const symbols = Array.isArray(universe.symbols) ? universe.symbols as string[] : [];
  return symbols.filter((s) => {
    const src = CONSTITUENTS[s]?.source;
    return src !== "etf";
  });
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Equity fundamentals: batch-scoped, ungated, daily cadence. Yahoo quoteSummary
// modules summaryDetail,defaultKeyStatistics,financialData over universe equities
// → options.fundamentals. Session opened once per pass (same crumb path as etf-daily).
//
// Dry-run: without PIPELINE_FUNDAMENTALS_URL the pass is a no-op.
export function fundamentalsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "FUNDAMENTALS_CONCURRENCY", 3)));
  return {
    id: "fundamentals-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "FUNDAMENTALS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => fundamentalsUniverse(),
    run: async (items, e) => {
      if (!e.PIPELINE_FUNDAMENTALS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const fundEnv: FundamentalsEnv = {
        ...(e as unknown as FundamentalsEnv),
        runId: () => runId,
      };
      const session = fundEnv.yahooSession ?? await openYahooSession(fundEnv);
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishFundamentals(symbol, fundEnv, session);
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
      return { runId, failures };
    },
  };
}
