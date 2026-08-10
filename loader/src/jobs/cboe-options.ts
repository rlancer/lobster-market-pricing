import type { ItemJob, SchedulerEnv } from "../scheduler.js";
import { runSymbols } from "../run-symbols.js";
import universe from "../../symbols/universe.json";

const SYMBOLS = Array.isArray(universe.symbols) ? universe.symbols : [];

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// CBOE S&P 500 options: item-scoped, market-gated, continuous cadence. Item
// store is `symbol_state`; the scheduler owns per-symbol due/backoff and this
// adapter maps a due batch through runSymbols (items-in / failures-out).
export function cboeOptionsJob(env: SchedulerEnv): ItemJob {
  return {
    id: "cboe-options",
    marketGated: true,
    cadenceSeconds: Math.floor(num(env, "LOADER_CADENCE_SECONDS", 900)),
    scope: "items",
    itemTable: "symbol_state",
    itemIdColumn: "symbol",
    seedItems: async (db) => {
      const now = Date.now();
      const base = num(env, "LOADER_BACKOFF_BASE_SECONDS", 60);
      for (const symbol of SYMBOLS) {
        await db.prepare(
          `INSERT OR IGNORE INTO symbol_state
             (symbol, enabled, last_success_at, last_attempt_at, consecutive_failures,
              next_attempt_after, backoff_seconds, last_error, priority)
           VALUES (?, 1, NULL, NULL, 0, ?, ?, NULL, 0)`
        ).bind(symbol, now, base).run();
      }
      console.log(JSON.stringify({ event: "seeded_symbol_state", symbols: SYMBOLS.length }));
    },
    run: async (items, e) => {
      const result = await runSymbols(items, e);
      return {
        runId: (result && result.run && result.run.run_id) ? String(result.run.run_id) : null,
        failures: Array.isArray(result && result.failures)
          ? result.failures.map((f) => ({
              symbol: f && f.symbol,
              error: String((f && f.error) || "unknown"),
            }))
          : [],
      };
    },
  };
}
