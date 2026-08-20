import type { BatchJob, JobRunFailure, SchedulerEnv, D1Database } from "../scheduler.js";
import type { SecEnv } from "../sec.js";
import { loadCikMap, publishSecFilings } from "../sec.js";
import { listEnrolledSymbols } from "../enrolled-universe.js";
import universe from "../../symbols/universe.json";
import etfs from "../../symbols/etfs.json";

type Constituent = { name?: string; sector?: string; source?: string };

const CONSTITUENTS: Record<string, Constituent> =
  universe && typeof universe === "object" && "constituents" in universe
    ? (universe.constituents as Record<string, Constituent>)
    : {};

const ETF_ROWS: Array<{ symbol: string }> = Array.isArray(etfs.etfs) ? etfs.etfs : [];
const ETF_SET = new Set(ETF_ROWS.map((e) => e.symbol.toUpperCase()));

/** Bundled equities (non-ETF sleeve) ∪ curated ETFs. */
export function secFilingsBundledUniverse(): string[] {
  const symbols = Array.isArray(universe.symbols) ? (universe.symbols as string[]) : [];
  const equities = symbols.filter((s) => CONSTITUENTS[s]?.source !== "etf");
  const etfSymbols = ETF_ROWS.map((e) => e.symbol);
  // Stable: equities first (manifest order), then ETF manifest order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...equities, ...etfSymbols]) {
    const u = s.toUpperCase();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(s);
  }
  return out;
}

/**
 * Bundled universe ∪ on-demand enrolled tickers. Enrolled names are treated as
 * equities for form-type filtering unless they appear in etfs.json.
 */
export async function secFilingsEffectiveUniverse(db?: D1Database): Promise<string[]> {
  const bundled = secFilingsBundledUniverse();
  if (!db) return bundled;
  const set = new Set(bundled.map((s) => s.toUpperCase()));
  const extras: string[] = [];
  for (const s of await listEnrolledSymbols(db)) {
    const u = s.toUpperCase();
    if (set.has(u)) continue;
    set.add(u);
    extras.push(s);
  }
  extras.sort();
  return [...bundled, ...extras];
}

export function isEtfTicker(ticker: string): boolean {
  const u = ticker.toUpperCase();
  return ETF_SET.has(u) || CONSTITUENTS[u]?.source === "etf" || CONSTITUENTS[ticker]?.source === "etf";
}

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// SEC EDGAR filings + ETF prospectuses: batch-scoped, ungated, daily cadence.
// Equities → 10-K/10-Q/8-K; ETFs → N-1A / 485BPOS / 497 family (+ equity forms
// when present). Metadata + edgar_url land in options.sec_filings (append-only;
// historical pile-up). Dry-run without PIPELINE_SEC_FILINGS_URL.
export function secFilingsDailyJob(env: SchedulerEnv): BatchJob {
  const concurrency = Math.max(1, Math.floor(num(env, "SEC_FILINGS_CONCURRENCY", 2)));
  return {
    id: "sec-filings-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "SEC_FILINGS_CADENCE_SECONDS", 86400)),
    scope: "batch",
    universe: (db) => secFilingsEffectiveUniverse(db),
    run: async (items, e) => {
      if (!e.PIPELINE_SEC_FILINGS_URL) {
        return { runId: null, failures: [] };
      }
      const runId = typeof e.runId === "function" ? e.runId() : crypto.randomUUID();
      const secEnv: SecEnv = {
        ...(e as unknown as SecEnv),
        runId: () => runId,
      };
      const cikMap = await loadCikMap(secEnv);
      const failures: JobRunFailure[] = [];
      let next = 0;
      const worker = async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const symbol = items[index];
          try {
            await publishSecFilings(symbol, secEnv, {
              isEtf: isEtfTicker(symbol),
              cikMap,
            });
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
