import type { ItemJob, JobRunFailure, SchedulerEnv } from "../scheduler.js";
import universe from "../../symbols/universe.json";

const SYMBOLS = Array.isArray(universe.symbols) ? (universe.symbols as string[]) : [];

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function str(env: SchedulerEnv, key: string): string {
  const v = env && env[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Normalize API base (no trailing slash). */
export function researchApiBase(env: SchedulerEnv): string {
  return str(env, "RESEARCH_API_BASE").replace(/\/+$/, "");
}

export function researchWarmConfigured(env: SchedulerEnv): boolean {
  return !!(researchApiBase(env) && str(env, "ADMIN_TOKEN"));
}

export interface WarmApiResponse {
  attempted?: number;
  warmed?: number;
  failed?: number;
  results?: Array<{ ticker?: string; ok?: boolean; error?: string }>;
  error?: string;
}

/**
 * POST a ticker batch to the API Worker warm endpoint. Exported for tests.
 * Throws on transport / non-2xx / malformed responses; per-ticker failures are
 * returned in `failures` (job-level success with partial errors).
 */
export async function warmResearchBatch(
  tickers: string[],
  env: SchedulerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ runId: string | null; failures: JobRunFailure[] }> {
  const base = researchApiBase(env);
  const token = str(env, "ADMIN_TOKEN");
  if (!base || !token) {
    return { runId: null, failures: [] };
  }
  const concurrency = Math.max(1, Math.floor(num(env, "RESEARCH_WARM_CONCURRENCY", 3)));
  const res = await fetchImpl(`${base}/api/research/warm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "cboe-to-r2/research-briefs-daily",
    },
    body: JSON.stringify({ tickers, concurrency }),
  });
  const text = await res.text();
  let body: WarmApiResponse = {};
  try {
    body = text ? (JSON.parse(text) as WarmApiResponse) : {};
  } catch {
    throw new Error(`research warm non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(body.error || `research warm HTTP ${res.status}`);
  }
  const failures: JobRunFailure[] = [];
  const results = Array.isArray(body.results) ? body.results : [];
  for (const row of results) {
    if (row && row.ok === false) {
      failures.push({
        symbol: String(row.ticker || "").toUpperCase() || "UNKNOWN",
        error: String(row.error || "warm failed"),
      });
    }
  }
  // Tickers the API dropped (invalid) count as failures so the item store retries.
  const okSet = new Set(
    results.filter((r) => r && r.ok !== false).map((r) => String(r.ticker || "").toUpperCase()),
  );
  for (const symbol of tickers) {
    const key = symbol.toUpperCase();
    if (!okSet.has(key) && !failures.some((f) => f.symbol === key)) {
      failures.push({ symbol: key, error: "ticker missing from warm response" });
    }
  }
  return { runId: crypto.randomUUID(), failures };
}

// Research brief warm: item-scoped, ungated, daily cadence. Each due batch is
// POSTed to the API Worker (`POST /api/research/warm`, Bearer ADMIN_TOKEN),
// which force-recomputes lake→D1 `ticker_research` rows. Spreading the universe
// across passes (LOADER_BATCH_SIZE) keeps each pass inside the run timeout and
// avoids stampeding R2 SQL.
//
// Dry-run: without RESEARCH_API_BASE + ADMIN_TOKEN the pass is a no-op.
export function researchBriefsDailyJob(env: SchedulerEnv): ItemJob {
  return {
    id: "research-briefs-daily",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "RESEARCH_BRIEFS_CADENCE_SECONDS", 86400)),
    scope: "items",
    itemTable: "research_brief_state",
    itemIdColumn: "symbol",
    seedSize: () => SYMBOLS.length,
    seedItems: async (db) => {
      const now = Date.now();
      const base = num(env, "LOADER_BACKOFF_BASE_SECONDS", 60);
      for (const symbol of SYMBOLS) {
        await db.prepare(
          `INSERT OR IGNORE INTO research_brief_state
             (symbol, enabled, last_success_at, last_attempt_at,
              consecutive_failures, next_attempt_after, backoff_seconds,
              last_error, priority)
           VALUES (?, 1, NULL, NULL, 0, ?, ?, NULL, 0)`,
        ).bind(symbol, now, base).run();
      }
      console.log(JSON.stringify({ event: "seeded_research_brief_state", symbols: SYMBOLS.length }));
    },
    run: async (items, e) => {
      if (!researchWarmConfigured(e)) {
        return { runId: null, failures: [] };
      }
      const fetchImpl =
        typeof (e as { fetchImpl?: typeof fetch }).fetchImpl === "function"
          ? (e as { fetchImpl: typeof fetch }).fetchImpl
          : fetch;
      return warmResearchBatch(items, e, fetchImpl);
    },
  };
}
