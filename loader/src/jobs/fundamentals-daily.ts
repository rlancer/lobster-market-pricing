import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { FundamentalsEnv } from "../fundamentals.js";
import { openYahooSession } from "../etf.js";
import { publishFundamentals } from "../fundamentals.js";
import universe from "../../symbols/universe.json";
import { listEnrolledSymbols } from "../enrolled-universe.js";

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

/**
 * Bundled equity sleeve ∪ on-demand enrolled tickers (enrolled names are treated
 * as equities; Yahoo no-ops harmlessly for true ETFs that land here).
 */
export async function fundamentalsEffectiveUniverse(db?: D1Database): Promise<string[]> {
  const bundled = fundamentalsUniverse();
  if (!db) return bundled;
  const set = new Set(bundled.map((s) => s.toUpperCase()));
  for (const s of await listEnrolledSymbols(db)) {
    if (CONSTITUENTS[s]?.source === "etf") continue;
    set.add(s);
  }
  // Keep stable order: bundled equities first, then enrolled extras sorted.
  const extras = Array.from(set).filter((s) => !bundled.includes(s)).sort();
  return [...bundled, ...extras];
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
    universe: (db) => fundamentalsEffectiveUniverse(db),
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
