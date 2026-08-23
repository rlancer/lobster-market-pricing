import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { CompanyFactsEnv } from "../company-facts.js";
import { loadCikMap } from "../sec.js";
import { publishCompanyFacts } from "../company-facts.js";
import universe from "../../symbols/universe.json";
import { listEnrolledSymbols } from "../enrolled-universe.js";

type Constituent = { name?: string; sector?: string; source?: string };

const CONSTITUENTS: Record<string, Constituent> =
  universe && typeof universe === "object" && "constituents" in universe
    ? (universe.constituents as Record<string, Constituent>)
    : {};

/** Equity sleeve only — ETFs are not in companyfacts the same way. */
export function companyFactsUniverse(): string[] {
  const symbols = Array.isArray(universe.symbols) ? (universe.symbols as string[]) : [];
  return symbols.filter((s) => CONSTITUENTS[s]?.source !== "etf");
}

export async function companyFactsEffectiveUniverse(db?: D1Database): Promise<string[]> {
  const bundled = companyFactsUniverse();
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

// SEC XBRL companyfacts: batch, ungated, daily. Low concurrency (SEC fair-access).
// → options.company_facts. Dry-run without PIPELINE_COMPANY_FACTS_URL.
export function companyFactsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "COMPANY_FACTS_CONCURRENCY", 2)));
  return {
    id: "company-facts-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "COMPANY_FACTS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: (db) => companyFactsEffectiveUniverse(db),
    run: async (items, e) => {
      if (!e.PIPELINE_COMPANY_FACTS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const factsEnv: CompanyFactsEnv = {
        ...(e as unknown as CompanyFactsEnv),
        runId: () => runId,
      };
      const cikMap = await loadCikMap({
        SEC_TICKERS_URL: factsEnv.SEC_TICKERS_URL,
        SEC_USER_AGENT: factsEnv.SEC_USER_AGENT,
        HTTP_RETRIES: factsEnv.HTTP_RETRIES,
        RETRY_BACKOFF_SECONDS: factsEnv.RETRY_BACKOFF_SECONDS,
        REQUEST_TIMEOUT: factsEnv.REQUEST_TIMEOUT,
        cikByTicker: factsEnv.cikByTicker,
      });
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishCompanyFacts(symbol, factsEnv, { cikMap });
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
