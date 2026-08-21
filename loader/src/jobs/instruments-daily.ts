import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { InstrumentsEnv } from "../instruments.js";
import { publishInstruments } from "../instruments.js";
import { listEnrolledSymbols } from "../enrolled-universe.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Instrument classification dimension: batch-scoped, ungated, daily cadence.
// Publishes one latest-wins row per symbol covering the full OHLC universe —
// equity + ETF (universe.json ∪ enrolled_symbols), indexes, continuous
// futures, and spot crypto — into options.instruments with an extendable
// security_type (equity | etf | index | future | crypto).
//
// Dry-run: without PIPELINE_INSTRUMENTS_URL the pass is a no-op.
export function instrumentsDailyJob(env: SchedulerEnv): BatchJob {
  return {
    id: "instruments-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "INSTRUMENTS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    // Single sentinel — the handler publishes the whole catalog in one POST.
    universe: () => ["catalog"],
    run: async (_items, e) => {
      if (!e.PIPELINE_INSTRUMENTS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const instrumentsEnv: InstrumentsEnv = {
        ...(e as unknown as InstrumentsEnv),
        runId: () => runId,
      };
      const failures: JobRunFailure[] = [];
      try {
        const db = e.LOADER_DB as D1Database | undefined;
        const enrolled = db ? await listEnrolledSymbols(db) : [];
        await publishInstruments(instrumentsEnv, enrolled);
      } catch (error) {
        failures.push({
          symbol: "catalog",
          error: String((error && (error as Error).message) || error),
        });
      }
      return { runId, failures };
    },
  };
}
