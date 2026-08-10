import type { ItemJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { OhlcEnv } from "../ohlc.js";
import { publishOhlcRange } from "../ohlc.js";
import { securityIdForTicker } from "../symbology.js";
import universe from "../../symbols/universe.json";

const SYMBOLS = Array.isArray(universe.symbols) ? universe.symbols : [];

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// The backfill window: past N days (epoch seconds) ending now. 730 days ≈ 2y
// (~504 trading days per symbol). Exported for tests.
export const BACKFILL_WINDOW_DAYS = 730;

export function windowBounds(nowMs: number): { period1: number; period2: number } {
  const period2 = Math.floor(nowMs / 1000);
  const period1 = period2 - BACKFILL_WINDOW_DAYS * 86400;
  return { period1, period2 };
}

// Merged-universe 2y OHLC backfill: item-scoped (resumable per-symbol), ungated,
// run manually via POST /jobs/ohlc-backfill/trigger or by seeding the item store.
// Item store `ohlc_backfill_state` mirrors symbol_state so a long run against
// unauth Yahoo (which throttles) picks up where it left off.
//
// Each pass computes the 2y window from `now`, then walks the due items through
// publishOhlcRange (OHLC + realized-vol + corporate-actions). security_id is
// the deterministic ticker-derived id (see symbology.ts), kept in lockstep with
// figi_map and the corporate-actions path so joins line up.
export function ohlcBackfillJob(env: SchedulerEnv): ItemJob {
  const concurrency = Math.max(1, Math.floor(num(env, "OHLC_CONCURRENCY", 4)));
  return {
    id: "ohlc-backfill",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "OHLC_BACKFILL_CADENCE_SECONDS", 7 * 86400)),
    scope: "items",
    itemTable: "ohlc_backfill_state",
    itemIdColumn: "symbol",
    seedItems: async (db) => {
      const now = Date.now();
      const base = num(env, "LOADER_BACKOFF_BASE_SECONDS", 60);
      for (const symbol of SYMBOLS) {
        await db.prepare(
          `INSERT OR IGNORE INTO ohlc_backfill_state
             (symbol, security_id, enabled, last_success_at, last_attempt_at,
              consecutive_failures, next_attempt_after, backoff_seconds,
              last_error, priority)
           VALUES (?, ?, 1, NULL, NULL, 0, ?, ?, NULL, 0)`
        ).bind(symbol, securityIdForTicker(symbol), now, base).run();
      }
      console.log(JSON.stringify({ event: "seeded_ohlc_backfill_state", symbols: SYMBOLS.length }));
    },
    run: async (items, e) => {
      // Dry-run: with no Pipeline endpoint configured the pass is a no-op (no
      // source fetches, no publishes) — same guard as ohlc-daily.
      if (!e.PIPELINE_OHLC_URL && !e.PIPELINE_REALIZED_VOL_URL && !e.PIPELINE_CORPORATE_ACTIONS_URL) {
        return { runId: null, failures: [] };
      }
      const { period1, period2 } = windowBounds(Date.now());
      const runId = (e as { runId?: () => string }).runId?.() ?? crypto.randomUUID();
      const ohlcEnv: OhlcEnv = {
        ...(e as unknown as OhlcEnv),
        runId: () => runId,
      };

      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishOhlcRange(symbol, period1, period2, ohlcEnv, securityIdForTicker(symbol));
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
