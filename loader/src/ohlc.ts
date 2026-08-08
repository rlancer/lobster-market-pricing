// OHLC + realized-vol enrichment path for the options lake.
//
// Prototype (Data Enrichment plan, Tier 1 #1/#4): fetch daily spot OHLC for a
// symbol, compute realized volatility from log returns, and normalize/publish
// two new tables:
//   - options.ohlc         (per-symbol daily bars)
//   - options.realized_vol (per-symbol latest realized-vol snapshot)
//
// Pure module (only depends on global fetch / crypto), mirroring the fetch +
// retry + Pipeline-publish style of run-symbols.ts so it can be published from
// the same Worker and is directly testable.

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------
// Yahoo chart JSON is the current live-fetchable source (works with a
// user-agent, no key). Stooq's CSV endpoint was rejected: it is behind a
// JS proof-of-work challenge and returns HTML, not data.
export const DEFAULT_OHLC_URL_TEMPLATE =
  "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1y&interval=1d";

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 30;
export const ANNUALIZATION_FACTOR = 252;

export const OHLC_FIELDS = [
  "symbol", "date", "open", "high", "low", "close", "volume", "source",
  "run_id", "as_of_date", "fetched_at",
] as const;

export const REALIZED_VOL_FIELDS = [
  "symbol", "as_of_date", "realized_vol_30d", "realized_vol_90d",
  "n_returns_30", "n_returns_90", "run_id", "fetched_at",
] as const;

export interface DailyBar {
  date: string; // YYYY-MM-DD (exchange-local trading day)
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

// Env consumed by the OHLC path. Pipeline URLs are secret-backed at runtime
// (same model as PIPELINE_* in run-symbols.ts). now/runId are optional test
// seams.
export interface OhlcEnv {
  OHLC_URL_TEMPLATE?: string;
  OHLC_SOURCE?: string;
  PIPELINE_OHLC_URL?: string;
  PIPELINE_REALIZED_VOL_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  now?: () => Date;
  runId?: () => string;
}

export interface RealizedVolResult {
  as_of_date: string;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
  n_returns_30: number;
  n_returns_90: number;
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoDate(tsSec: number, offsetSec: number): string {
  const d = new Date((tsSec + offsetSec) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
// Narrow a parsed-JSON value that is known to be a plain object.
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Parse a Yahoo v8 chart response into ascending-by-date daily bars.
export function parseYahooChart(payload: unknown, symbol: string): DailyBar[] {
  const chart = asRecord(payload)?.chart as unknown;
  const result = asRecord(chart)?.result as unknown;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  if (!first) throw new Error(`yahoo chart for ${symbol}: no result`);

  const meta = asRecord(first.meta);
  const offsetSec = typeof meta?.gmtoffset === "number" ? meta.gmtoffset : 0;
  const timestamps = Array.isArray(first.timestamp) ? first.timestamp : [];

  const quote = asRecord(first.indicators)?.quote as unknown;
  const q0 = asRecord(Array.isArray(quote) ? quote[0] : null);

  const toNum = (arr: unknown, i: number): number | null => {
    const v = Array.isArray(arr) ? arr[i] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    bars.push({
      date: isoDate(ts, offsetSec),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      open: toNum(q0!.open, i),
      high: toNum(q0!.high, i),
      low: toNum(q0!.low, i),
      close: toNum(q0!.close, i),
      volume: toNum(q0!.volume, i),
    });
  }
  if (bars.length === 0) {
    throw new Error(`yahoo chart for ${symbol}: no bars`);
  }
  return bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Realized volatility
// ---------------------------------------------------------------------------
// Sample stdev of log-returns over a trailing window of trading days,
// annualized by sqrt(ANNUALIZATION_FACTOR). Needs (lookback+1) closes for
// `lookback` returns; returns null when insufficient.
function realizedVolFromCloses(
  closes: number[],
  lookback: number,
): { value: number | null; n: number } {
  if (closes.length < lookback + 1) return { value: null, n: 0 };
  const window = closes.slice(-(lookback + 1));
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const cur = window[i];
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) {
      returns.push(Math.log(cur / prev));
    }
  }
  if (returns.length < 2) return { value: null, n: returns.length };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  return {
    value: Math.sqrt(variance) * Math.sqrt(ANNUALIZATION_FACTOR),
    n: returns.length,
  };
}

// Compute realized-vol snapshots from ascending daily bars over the trailing
// 30- and 90-trading-day windows.
export function realizedVols(bars: DailyBar[]): RealizedVolResult {
  const closes = bars
    .map((b) => b.close)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0);
  const lastDate = [...bars].reverse().find((b) => b.date)?.date ?? "";
  const r30 = realizedVolFromCloses(closes, 30);
  const r90 = realizedVolFromCloses(closes, 90);
  return {
    as_of_date: lastDate,
    realized_vol_30d: r30.value,
    realized_vol_90d: r90.value,
    n_returns_30: r30.n,
    n_returns_90: r90.n,
  };
}

// ---------------------------------------------------------------------------
// Normalize (records exactly follow OHLC_FIELDS / REALIZED_VOL_FIELDS order)
// ---------------------------------------------------------------------------
export function normalizeOhlcRecords(
  symbol: string,
  bars: DailyBar[],
  source: string,
  runId: string,
  asOfDate: string,
  fetchedAt: string,
): Array<Record<string, unknown>> {
  return bars.map((b) => {
    const rec: Record<string, unknown> = {
      symbol, date: b.date, open: b.open, high: b.high, low: b.low,
      close: b.close, volume: b.volume, source,
      run_id: runId, as_of_date: asOfDate, fetched_at: fetchedAt,
    };
    const out: Record<string, unknown> = {};
    for (const f of OHLC_FIELDS) out[f] = rec[f];
    return out;
  });
}

export function normalizeRealizedVolRecord(
  symbol: string,
  rv: RealizedVolResult,
  runId: string,
  fetchedAt: string,
): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    symbol, as_of_date: rv.as_of_date,
    realized_vol_30d: rv.realized_vol_30d, realized_vol_90d: rv.realized_vol_90d,
    n_returns_30: rv.n_returns_30, n_returns_90: rv.n_returns_90,
    run_id: runId, fetched_at: fetchedAt,
  };
  const out: Record<string, unknown> = {};
  for (const f of REALIZED_VOL_FIELDS) out[f] = rec[f];
  return out;
}

// ---------------------------------------------------------------------------
// HTTP / publish
// ---------------------------------------------------------------------------
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

function backoffSeconds(env: OhlcEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

// POST a payload to a Pipeline endpoint (5xx/network retries, 4xx hard-fail),
// mirroring request_json() in run-symbols.ts. Shared idempotency model.
async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: OhlcEnv,
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

// GET a Yahoo chart with retry/backoff parity with fetchChain() in run-symbols.
async function fetchOhlc(symbol: string, env: OhlcEnv): Promise<unknown> {
  const template = env.OHLC_URL_TEMPLATE || DEFAULT_OHLC_URL_TEMPLATE;
  const url = template.replace("{symbol}", encodeURIComponent(symbol));
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
          headers: { "user-agent": "cboe-to-r2/0.2" },
          signal: controller.signal,
        });
        if (response.ok) return await response.json();
        const code = response.status;
        lastError = new Error(`OHLC source returned HTTP ${code}`);
        if (code !== 408 && code !== 429 && code < 500) throw lastError;
        if (attempt < retries) {
          const retryAfter = Number(response.headers.get("retry-after") || "0");
          await sleep(Math.max(backoffSeconds(env, attempt), Number.isFinite(retryAfter) ? retryAfter : 0) * 1000);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    }
  }
  throw new Error(`OHLC request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export interface OhlcRunResult {
  symbol: string;
  bar_count: number;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
  published_ohlc: boolean;
  published_realized_vol: boolean;
}

// Fetch + normalize + publish one symbol's OHLC and realized-vol snapshot.
// Returns when both pipelines accepted their payloads (no-op when a pipeline
// URL is unset — useful for dry-run/local probing).
export async function publishOhlc(symbol: string, env: OhlcEnv = {}): Promise<OhlcRunResult> {
  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const asOfDate = fetchedAt.slice(0, 10);
  const source = env.OHLC_SOURCE || "yahoo";

  const payload = await fetchOhlc(symbol, env);
  const bars = parseYahooChart(payload, symbol);
  const rv = realizedVols(bars);

  const ohlcRecords = normalizeOhlcRecords(
    symbol, bars, source, runId, asOfDate, fetchedAt,
  );
  const rvRecord = normalizeRealizedVolRecord(symbol, rv, runId, fetchedAt);

  const ohlcUrl = env.PIPELINE_OHLC_URL || "";
  const rvUrl = env.PIPELINE_REALIZED_VOL_URL || "";
  const authToken = env.PIPELINE_AUTH_TOKEN || "";

  let publishedOhlc = false;
  let publishedRv = false;
  if (ohlcUrl) {
    await requestJson(ohlcUrl, ohlcRecords, `${runId}:ohlc:${symbol}`, authToken, env);
    publishedOhlc = true;
  }
  if (rvUrl) {
    await requestJson(rvUrl, rvRecord, `${runId}:rv:${symbol}`, authToken, env);
    publishedRv = true;
  }

  return {
    symbol,
    bar_count: bars.length,
    realized_vol_30d: rv.realized_vol_30d,
    realized_vol_90d: rv.realized_vol_90d,
    published_ohlc: publishedOhlc,
    published_realized_vol: publishedRv,
  };
}
