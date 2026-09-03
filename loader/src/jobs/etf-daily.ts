import type { BatchJob, D1Database, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import type { EtfEnv } from "../etf.js";
import { openYahooSession, publishEtf } from "../etf.js";
import { listEnrolledSymbolsByType } from "../enrolled-universe.js";
import etfs from "../../symbols/etfs.json";

const ETF_ROWS: Array<{ symbol: string; name: string; asset_class: string }> =
  Array.isArray(etfs.etfs) ? etfs.etfs : [];

/** Curated optionable ETFs from symbols/etfs.json (92 names). */
export function bundledEtfUniverse(): string[] {
  return ETF_ROWS.map((e) => e.symbol);
}

/** @deprecated Use bundledEtfUniverse — kept so existing tests keep the 92-name contract. */
export function etfUniverse(): string[] {
  return bundledEtfUniverse();
}

/** Bundled optionable ETFs ∪ enrolled funds (security_type etf|fund). */
export async function etfEffectiveUniverse(db?: D1Database): Promise<string[]> {
  const bundled = bundledEtfUniverse();
  if (!db) return bundled;
  const extra = await listEnrolledSymbolsByType(db, ["etf", "fund"]);
  const set = new Set(bundled);
  for (const symbol of extra) set.add(symbol);
  return Array.from(set);
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// ETF fund profile + top holdings: batch-scoped, ungated, daily cadence.
// Universe is symbols/etfs.json (the 92 optionable ETFs) union enrolled
// tickers with security_type etf|fund — Copilot lookup_symbols enrolls
// funds that are not CBOE-optionable. Equities have no fundProfile.
// Yahoo quoteSummary needs a crumb session opened once per pass and reused.
//
// Dry-run: without either Pipeline URL the pass is a no-op.
export function etfDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "ETF_CONCURRENCY", 3)));
  const bySymbol = new Map(ETF_ROWS.map((e) => [e.symbol, e]));
  return {
    id: "etf-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "ETF_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: (db) => etfEffectiveUniverse(db),
    run: async (items, e) => {
      if (!e.PIPELINE_ETF_PROFILES_URL && !e.PIPELINE_ETF_HOLDINGS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const etfEnv: EtfEnv = {
        ...(e as unknown as EtfEnv),
        runId: () => runId,
      };
      const session = etfEnv.yahooSession ?? await openYahooSession(etfEnv);
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          const meta = bySymbol.get(symbol) ?? {};
          try {
            await publishEtf(symbol, etfEnv, meta, session);
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
