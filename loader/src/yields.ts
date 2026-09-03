// US Treasury / rates curve enrichment for the options lake.
//
// Fetches curated FRED series observations (constant-maturity Treasuries,
// curve spreads, TIPS / breakevens, overnight policy rates) and publishes
// normalized rows to `options.yields` via a Pipeline. Values are the FRED
// published units — percent for DGS*/DFII*/DFF/SOFR and percentage points for
// spreads / breakevens (e.g. 4.25 = 4.25%).
//
// Pure module (only depends on global fetch / crypto), mirroring econ.ts so
// the same Worker can publish it and Vitest can drive it without a DO.

// ---------------------------------------------------------------------------
// Curated series allowlist
// ---------------------------------------------------------------------------
// Constant-maturity H.15 curve + a few spreads / real yields / policy rates
// that everything else is priced off of. Exact same ids the Worker docs and
// Chat prompt teach, so the lake and the chat agree.
export type YieldKind = "nominal" | "real" | "breakeven" | "forward" | "spread" | "policy";

export interface YieldSeriesMeta {
  title: string;
  /** Human tenor label (1M, 10Y, ON, …); null for derived spreads. */
  tenor: string | null;
  kind: YieldKind;
}

export const YIELD_SERIES: Record<string, YieldSeriesMeta> = {
  DGS1MO: { title: "1-Month Treasury Constant Maturity", tenor: "1M", kind: "nominal" },
  DGS3MO: { title: "3-Month Treasury Constant Maturity", tenor: "3M", kind: "nominal" },
  DGS6MO: { title: "6-Month Treasury Constant Maturity", tenor: "6M", kind: "nominal" },
  DGS1: { title: "1-Year Treasury Constant Maturity", tenor: "1Y", kind: "nominal" },
  DGS2: { title: "2-Year Treasury Constant Maturity", tenor: "2Y", kind: "nominal" },
  DGS3: { title: "3-Year Treasury Constant Maturity", tenor: "3Y", kind: "nominal" },
  DGS5: { title: "5-Year Treasury Constant Maturity", tenor: "5Y", kind: "nominal" },
  DGS7: { title: "7-Year Treasury Constant Maturity", tenor: "7Y", kind: "nominal" },
  DGS10: { title: "10-Year Treasury Constant Maturity", tenor: "10Y", kind: "nominal" },
  DGS20: { title: "20-Year Treasury Constant Maturity", tenor: "20Y", kind: "nominal" },
  DGS30: { title: "30-Year Treasury Constant Maturity", tenor: "30Y", kind: "nominal" },
  T10Y2Y: { title: "10-Year Treasury Minus 2-Year Treasury", tenor: null, kind: "spread" },
  T10Y3M: { title: "10-Year Treasury Minus 3-Month Treasury", tenor: null, kind: "spread" },
  T5YIE: { title: "5-Year Breakeven Inflation Rate", tenor: "5Y", kind: "breakeven" },
  T10YIE: { title: "10-Year Breakeven Inflation Rate", tenor: "10Y", kind: "breakeven" },
  T5YIFR: {
    title: "5-Year, 5-Year Forward Inflation Expectation Rate",
    tenor: "5Y5Y",
    kind: "forward",
  },
  DFII5: { title: "5-Year Treasury Inflation-Indexed Security", tenor: "5Y", kind: "real" },
  DFII10: { title: "10-Year Treasury Inflation-Indexed Security", tenor: "10Y", kind: "real" },
  DFF: { title: "Federal Funds Effective Rate", tenor: "ON", kind: "policy" },
  SOFR: { title: "Secured Overnight Financing Rate", tenor: "ON", kind: "policy" },
};

export const FRED_SERIES_OBSERVATIONS_URL =
  "https://api.stlouisfed.org/fred/series/observations";

export const YIELDS_SOURCE = "fred";

/** ~10y of history — enough for multi-year trend / regime context on direction asks. */
export const YIELDS_LOOKBACK_DAYS = 3650;

export const YIELDS_FIELDS = [
  "series_id", "date", "value", "title", "tenor", "kind", "source", "run_id", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export interface YieldsEnv {
  FRED_API_KEY?: string;
  PIPELINE_YIELDS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  YIELDS_LOOKBACK_DAYS?: number;
  now?: () => number;
  runId?: () => string;
}

export interface YieldRow {
  series_id: string;
  date: string; // YYYY-MM-DD
  value: number; // FRED units (percent / percentage points)
  title: string;
  tenor: string | null;
  kind: YieldKind;
  source: string;
}

export interface YieldPublishResult {
  item: string; // series_id
  row_count: number;
  published: boolean;
  run_id: string;
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Small shared helpers
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

function backoffSeconds(env: YieldsEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Universe
// ---------------------------------------------------------------------------
/** One series_id per fetch+publish unit (isolation like fred-econ-daily). */
export function yieldsSeriesList(): string[] {
  return Object.keys(YIELD_SERIES);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function fetchJson(url: string, env: YieldsEnv, label: string): Promise<unknown> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        const detail = await response.text();
        lastError = new Error(`${label} returned HTTP ${code}: ${detail.slice(0, 120)}`);
        if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

async function requestJson(
  url: string,
  body: unknown,
  idempotencyKey: string,
  authToken: string,
  env: YieldsEnv,
): Promise<void> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const payload = JSON.stringify(stripNones(body));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
    "idempotency-key": idempotencyKey,
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: payload });
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
    if (code < 500) throw lastError;
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------
const FRED_DATE = /^\d{4}-\d{2}-\d{2}$/;

function lookbackDays(env: YieldsEnv): number {
  return Math.max(1, Math.floor(num(env.YIELDS_LOOKBACK_DAYS, YIELDS_LOOKBACK_DAYS)));
}

function windowIso(env: YieldsEnv): { start: string; end: string } {
  const now = env.now ? env.now() : Date.now();
  return {
    start: isoDate(now - lookbackDays(env) * 86400000),
    end: isoDate(now),
  };
}

/** Parse one FRED observations payload → YieldRow[] (skips missing "." values). */
export function parseFredObservations(
  seriesId: string,
  payload: unknown,
): YieldRow[] {
  const meta = YIELD_SERIES[seriesId];
  if (!meta) throw new Error(`yields: unknown series_id ${seriesId}`);
  const data = asRecord(payload);
  const rows: YieldRow[] = [];
  for (const raw of Array.isArray(data?.observations) ? data.observations : []) {
    const o = asRecord(raw);
    const date = strip(o?.date);
    if (!FRED_DATE.test(date)) continue;
    const rawVal = strip(o?.value);
    if (!rawVal || rawVal === ".") continue;
    const value = Number(rawVal);
    if (!Number.isFinite(value)) continue;
    rows.push({
      series_id: seriesId,
      date,
      value,
      title: meta.title,
      tenor: meta.tenor,
      kind: meta.kind,
      source: YIELDS_SOURCE,
    });
  }
  return rows;
}

/** Fetch observations for one allowlisted series_id → YieldRow[]. */
export async function fetchYieldSeries(
  seriesId: string,
  env: YieldsEnv,
): Promise<YieldRow[]> {
  if (!YIELD_SERIES[seriesId]) {
    throw new Error(`yields: unknown series_id ${seriesId}`);
  }
  const key = env.FRED_API_KEY;
  if (!key) throw new Error(`yields:${seriesId} requires FRED_API_KEY`);
  const { start, end } = windowIso(env);
  const url =
    `${FRED_SERIES_OBSERVATIONS_URL}?api_key=${encodeURIComponent(key)}&file_type=json` +
    `&series_id=${encodeURIComponent(seriesId)}` +
    `&observation_start=${start}&observation_end=${end}` +
    `&sort_order=asc`;
  const data = await fetchJson(url, env, `fred series ${seriesId}`);
  return parseFredObservations(seriesId, data);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------
export async function publishYieldSeries(
  seriesId: string,
  env: YieldsEnv = {},
): Promise<YieldPublishResult> {
  const url = env.PIPELINE_YIELDS_URL || "";
  if (!url) throw new Error("yields publish requires PIPELINE_YIELDS_URL");
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = new Date(env.now ? env.now() : Date.now()).toISOString();
  const rows = await fetchYieldSeries(seriesId, env);
  if (rows.length === 0) {
    return {
      item: seriesId,
      row_count: 0,
      published: false,
      run_id: runId,
      fetched_at: fetchedAt,
    };
  }
  await requestJson(
    url,
    normalizeYieldRecords(rows, runId, fetchedAt),
    `yields:${runId}:${seriesId}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    item: seriesId,
    row_count: rows.length,
    published: true,
    run_id: runId,
    fetched_at: fetchedAt,
  };
}

export function normalizeYieldRecords(
  rows: YieldRow[],
  runId: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const rec: Record<string, unknown> = {
      series_id: r.series_id,
      date: r.date,
      value: r.value,
      title: r.title,
      tenor: r.tenor,
      kind: r.kind,
      source: r.source,
      run_id: runId,
      fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of YIELDS_FIELDS) out[f] = rec[f];
    return out;
  });
}
