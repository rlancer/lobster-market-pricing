import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { RegShoEnv } from "../reg-sho.js";
import {
  REG_SHO_LOOKBACK_DAYS_DEFAULT,
  publishRegShoDate,
  regShoTradeDateCandidates,
} from "../reg-sho.js";
import { bundledUniverse, effectiveUniverse } from "../enrolled-universe.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

async function regShoKeepSet(db: D1Database): Promise<Set<string>> {
  const symbols = await effectiveUniverse(db);
  return new Set(symbols.map((s) => s.toUpperCase()));
}

// FINRA Reg SHO daily short-sale volume: batch-scoped, ungated, daily cadence.
// Each pass walks the last REG_SHO_LOOKBACK_DAYS calendar dates, pages the
// FINRA regShoDaily API, rolls TRF facility rows up per symbol, filters to the
// effective universe (bundled ∪ enrolled), and publishes to
// options.reg_sho_daily via PIPELINE_REG_SHO_URL. Weekends/holidays (HTTP 204)
// are skipped, not failures.
//
// Dry-run: without PIPELINE_REG_SHO_URL the pass is a no-op.
export function regShoDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "REG_SHO_CONCURRENCY", 2)));
  const lookback = Math.max(
    1,
    Math.floor(num(env, "REG_SHO_LOOKBACK_DAYS", REG_SHO_LOOKBACK_DAYS_DEFAULT)),
  );
  return {
    id: "reg-sho-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "REG_SHO_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: () => regShoTradeDateCandidates(Date.now(), lookback),
    run: async (items, e) => {
      if (!e.PIPELINE_REG_SHO_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const regEnv: RegShoEnv = {
        ...(e as unknown as RegShoEnv),
        runId: () => runId,
      };
      const db = e.LOADER_DB as D1Database | undefined;
      const keep = db
        ? await regShoKeepSet(db)
        : new Set(bundledUniverse().map((s) => s.toUpperCase()));
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const date = items[index];
          try {
            await publishRegShoDate(date, regEnv, keep);
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
