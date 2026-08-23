import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { EarningsResultsEnv } from "../earnings-results.js";
import { openYahooSession } from "../etf.js";
import { publishEarningsResults } from "../earnings-results.js";
import universe from "../../symbols/universe.json";
import { listEnrolledSymbols } from "../enrolled-universe.js";

type Constituent = { name?: string; sector?: string; source?: string };

const CONSTITUENTS: Record<string, Constituent> =
  universe && typeof universe === "object" && "constituents" in universe
    ? (universe.constituents as Record<string, Constituent>)
    : {};

/** Equity sleeve of universe.json — ETFs have no earnings results. */
export function earningsResultsUniverse(): string[] {
  const symbols = Array.isArray(universe.symbols) ? (universe.symbols as string[]) : [];
  return symbols.filter((s) => CONSTITUENTS[s]?.source !== "etf");
}

export async function earningsResultsEffectiveUniverse(db?: D1Database): Promise<string[]> {
  const bundled = earningsResultsUniverse();
  if (!db) return bundled;
  const set = new Set(bundled.map((s) => s.toUpperCase()));
  for (const s of await listEnrolledSymbols(db)) {
    if (CONSTITUENTS[s]?.source === "etf") continue;
    set.add(s);
  }
  const extras = Array.from(set).filter((s) => !bundled.includes(s)).sort();
  return [...bundled, ...extras];
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Reported EPS actual vs estimate: batch, ungated, daily. Yahoo earningsHistory
// → options.earnings_results. Dry-run without PIPELINE_EARNINGS_RESULTS_URL.
export function earningsResultsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "EARNINGS_RESULTS_CONCURRENCY", 3)));
  return {
    id: "earnings-results-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "EARNINGS_RESULTS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: (db) => earningsResultsEffectiveUniverse(db),
    run: async (items, e) => {
      if (!e.PIPELINE_EARNINGS_RESULTS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const jobEnv: EarningsResultsEnv = {
        ...(e as unknown as EarningsResultsEnv),
        runId: () => runId,
      };
      const session = jobEnv.yahooSession ?? (await openYahooSession(jobEnv));
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishEarningsResults(symbol, jobEnv, session);
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
