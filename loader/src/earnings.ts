// Earnings-calendar enrichment path for the options lake.
//
// Tier-1 chat enrichment (see plan doc): fetch daily earnings calendars from
// Nasdaq's public calendar endpoint, filter to the S&P 500 manifest universe,
// and publish normalized upcoming-earnings rows to `options.earnings` via a
// Pipeline. Pure module (only depends on global fetch / crypto), mirroring the
// fetch + retry + Pipeline-publish style of ohlc.ts so it can be published
// from the same Worker and is directly testable.

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------
// Nasdaq's earnings calendar endpoint is keyless and returns one calendar
// date's worth of reports (symbol, name, time-of-day, EPS forecast, estimate
// count, last year's actuals) as JSON. Requires a browser-ish User-Agent.
// Verified live 2026-08-08 (200, ~200 rows/date). Unofficial and
// undocumented: the job treats failures as recorded per-date errors (the rest
// of the window still syncs) and the chat queries degrade to empty if the
// table is missing — same best-effort posture as the Yahoo OHLC path.
export const DEFAULT_EARNINGS_API_TEMPLATE =
  "https://api.nasdaq.com/api/calendar/earnings?date={date}";

// Browser-ish UA: Nasdaq blocks script UAs (403/404 HTML) on this endpoint.
export const DEFAULT_EARNINGS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const EARNINGS_SOURCE = "nasdaq";

export const EARNINGS_FIELDS = [
  "symbol", "earnings_date", "time", "name", "fiscal_q",
  "eps_forecast", "est_count", "last_year_eps", "source", "run_id", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export interface EarningsEnv {
  EARNINGS_API_TEMPLATE?: string;
  EARNINGS_USER_AGENT?: string;
  PIPELINE_EARNINGS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  now?: () => number; // epoch-ms seam for tests
  runId?: () => string; // stable run id for the whole pass
}

export interface EarningsRow {
  symbol: string;
  earnings_date: string; // YYYY-MM-DD (the calendar date the report is due)
  time: string | null; // "after-hours" | "pre-market" | null (= not supplied)
  name: string | null;
  fiscal_q: string | null; // e.g. "Jun/2026"
  eps_forecast: number | null;
  est_count: number | null;
  last_year_eps: number | null;
}

export interface EarningsPublishResult {
  date: string;
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — same convention as ohlc.ts)
// ---------------------------------------------------------------------------
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function stripNones(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNones);
  const rec = asRecord(value);
  if (rec) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

function backoffSeconds(env: EarningsEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
// Nasdaq money strings: "$3.18" → 3.18, "($0.07)" → -0.07, "" / null → null.
export function parseUsdAmount(raw: unknown): number | null {
  const s = strip(raw);
  if (!s) return null;
  const negative = s.startsWith("(") && s.endsWith(")");
  const n = Number(s.replace(/[$(),]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// "7" → 7, "N/A" / "" → null (integer count).
export function parseCount(raw: unknown): number | null {
  const s = strip(raw);
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// "time-after-hours" → "after-hours"; "time-not-supplied" → null.
function normalizeTime(raw: unknown): string | null {
  const s = strip(raw);
  if (!s) return null;
  const t = s.startsWith("time-") ? s.slice(5) : s;
  return t === "not-supplied" ? null : t;
}

// Parse a Nasdaq calendar payload ({data:{rows:[…]}}) into row records keyed
// to `earningsDate`. Duplicate symbols within one date collapse to the first.
// Malformed rows are skipped, not fatal — the calendar is a secondary source.
export function parseNasdaqEarnings(payload: unknown, earningsDate: string): EarningsRow[] {
  const rows = asRecord(asRecord(payload)?.data)?.rows;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: EarningsRow[] = [];
  for (const raw of rows) {
    const r = asRecord(raw);
    if (!r) continue;
    const symbol = strip(r.symbol).toUpperCase();
    if (!symbol) continue;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      earnings_date: earningsDate,
      time: normalizeTime(r.time),
      name: strip(r.name) || null,
      fiscal_q: strip(r.fiscalQuarterEnding) || null,
      eps_forecast: parseUsdAmount(r.epsForecast),
      est_count: parseCount(r.noOfEsts),
      last_year_eps: parseUsdAmount(r.lastYearEPS),
    });
  }
  return out;
}

// Normalize (records exactly follow EARNINGS_FIELDS order).
export function normalizeEarningsRecords(
  rows: EarningsRow[],
  source: string,
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      symbol: r.symbol, earnings_date: r.earnings_date, time: r.time,
      name: r.name, fiscal_q: r.fiscal_q, eps_forecast: r.eps_forecast,
      est_count: r.est_count, last_year_eps: r.last_year_eps,
      source, run_id: runId, fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of EARNINGS_FIELDS) out[f] = rec[f];
    return out;
  });
}

// ---------------------------------------------------------------------------
// HTTP / publish
// ---------------------------------------------------------------------------
// POST a payload to a Pipeline endpoint (5xx/network retries, 4xx hard-fail),
// mirroring request_json() in run-symbols.ts and ohlc.ts. Shared idempotency
// model (per run × date).
async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: EarningsEnv,
): Promise<void> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (authToken) {
    headers["authorization"] = `Bearer ${authToken}`;
    headers["idempotency-key"] = idempotencyKey;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(backoffSeconds(env, attempt) * 1000);
        continue;
      }
      break;
    }
    if (response.ok) return;
    const code = response.status;
    const detail = await response.text();
    lastError = new Error(`pipeline returned HTTP ${code}: ${detail}`);
    if (code < 500) throw lastError; // non-retryable 4xx
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

// GET one calendar date with bounded retry/backoff, mirroring fetchOhlc in
// ohlc.ts (retries all statuses up to HTTP_RETRIES, hard-fails only on
// transport exhaustion; a per-date failure is recorded by the job).
export async function fetchEarningsDate(date: string, env: EarningsEnv = {}): Promise<unknown> {
  const template = env.EARNINGS_API_TEMPLATE || DEFAULT_EARNINGS_API_TEMPLATE;
  const url = template.replace("{date}", date);
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const ua = env.EARNINGS_USER_AGENT || DEFAULT_EARNINGS_USER_AGENT;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: { "user-agent": ua, accept: "application/json" },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`nasdaq earnings returned HTTP ${code}: ${detail.slice(0, 120)}`);
        if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    }
  }
  throw new Error(`earnings fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

// Fetch + filter + normalize + publish ONE calendar date. `keepSymbols` (the
// S&P 500 manifest) narrows the broad Nasdaq calendar to the lake's universe;
// when absent, the whole day's calendar is kept (one-off runs / tests).
export async function publishEarningsDate(
  date: string,
  env: EarningsEnv = {},
  keepSymbols?: Set<string>,
): Promise<EarningsPublishResult> {
  const url = env.PIPELINE_EARNINGS_URL || "";
  if (!url) {
    throw new Error("earnings publish requires PIPELINE_EARNINGS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const payload = await fetchEarningsDate(date, env);
  const rows = parseNasdaqEarnings(payload, date);
  const kept = keepSymbols ? rows.filter((r) => keepSymbols.has(r.symbol)) : rows;
  if (kept.length === 0) {
    return { date, row_count: 0, published: false, run_id: runId, fetched_at: fetchedAt };
  }
  await requestJson(
    url,
    normalizeEarningsRecords(kept, EARNINGS_SOURCE, runId, fetchedAt),
    `earnings:${runId}:${date}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return { date, row_count: kept.length, published: true, run_id: runId, fetched_at: fetchedAt };
}

// YYYY-MM-DD (UTC) for `dayOffset` days after `now` (0 = today). The Nasdaq
// calendar is keyed by calendar date; UTC is within an hour of ET wall-clock
// from the job's perspective (a nightly run — skew is immaterial).
export function earningsDateForOffset(now: number, dayOffset: number): string {
  const d = new Date(now + dayOffset * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}