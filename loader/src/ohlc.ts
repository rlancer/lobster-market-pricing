// OHLC + realized-vol + corporate-actions enrichment path for the options lake.
//
// Prototype (Data Enrichment plan, Tier 1 #1/#4 + S&P500 OHLC backfill): fetch
// daily spot OHLC for a symbol over a window, compute realized volatility from
// ADJUSTED log returns, parse Yahoo's `events` block (dividends/splits) for
// corporate actions, and normalize/publish:
//   - options.ohlc              (per-symbol daily bars, (symbol,date) key)
//   - options.realized_vol      (per-symbol latest realized-vol snapshot)
//   - options.corporate_actions (splits / dividends)
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
//
// Two templates share the same endpoint:
//   - DEFAULT_OHLC_URL_TEMPLATE   — "range=1y&interval=1d" (the daily job)
//   - DEFAULT_OHLC_RANGE_TEMPLATE — "period1={period1}&period2={period2}"
//     (epoch seconds; used by the 2y backfill job). period1/period2 are
//     mutually exclusive with `range`.
// Both request `events=div,split` so Yahoo returns `adjclose` plus the
// dividend/split events we persist to options.corporate_actions.
export const DEFAULT_OHLC_URL_TEMPLATE =
  "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=1y&interval=1d&events=div,split";

export const DEFAULT_OHLC_RANGE_TEMPLATE =
  "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={period1}&period2={period2}&interval=1d&events=div,split";

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

export const CORPORATE_ACTION_FIELDS = [
  "security_id", "ticker", "action_type", "ex_date", "numerator",
  "denominator", "amount", "source", "run_id", "fetched_at",
] as const;

export interface DailyBar {
  date: string; // YYYY-MM-DD (exchange-local trading day)
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  // Split- and dividend-adjusted close from Yahoo's `adjclose` series. Used for
  // realized-vol returns so a stock split does not inject a spurious return.
  adjustedClose: number | null;
  volume: number | null;
}

export type CorporateActionType = "SPLIT" | "DIVIDEND";

export interface CorporateAction {
  security_id: string;
  ticker: string;
  action_type: CorporateActionType;
  ex_date: string; // YYYY-MM-DD
  numerator: number | null; // split: 4 (4-for-1)
  denominator: number | null; // split: 1
  amount: number | null; // dividend cash
  source: string;
  run_id: string;
  fetched_at: string;
}

// A (inclusive) epoch-second window for a range fetch. period1/period2 are the
// same params Yahoo's chart API accepts.
export interface OhlcWindow {
  period1: number; // epoch seconds
  period2: number; // epoch seconds
}

// Env consumed by the OHLC path. Pipeline URLs are secret-backed at runtime
// (same model as PIPELINE_* in run-symbols.ts). now/runId are optional test
// seams. securityIdFor optionally resolves a stable identity when the caller
// has symbology knowledge (backfill); default is symbol == security_id.
export interface OhlcEnv {
  OHLC_URL_TEMPLATE?: string;
  OHLC_SOURCE?: string;
  PIPELINE_OHLC_URL?: string;
  PIPELINE_REALIZED_VOL_URL?: string;
  PIPELINE_CORPORATE_ACTIONS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  securityIdFor?: (symbol: string) => string | null;
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
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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

// Parse a Yahoo v8 chart response into ascending-by-date daily bars. Reads
// `adjclose` from the indicators block in addition to the quote OHLCV.
export function parseYahooChart(payload: unknown, symbol: string): DailyBar[] {
  const chart = asRecord(payload)?.chart as unknown;
  const result = asRecord(chart)?.result as unknown;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  if (!first) throw new Error(`yahoo chart for ${symbol}: no result`);

  const meta = asRecord(first.meta);
  const offsetSec = typeof meta?.gmtoffset === "number" ? meta.gmtoffset : 0;
  const timestamps = Array.isArray(first.timestamp) ? first.timestamp : [];

  const indicators = asRecord(first.indicators);
  const quote = indicators?.quote ?? undefined;
  const q0 = asRecord(Array.isArray(quote) ? quote[0] : null);
  const adjcl = indicators?.adjclose ?? undefined;
  const adj0 = asRecord(Array.isArray(adjcl) ? adjcl[0] : null);

  const toNum = (arr: unknown, i: number): number | null => {
    const v = Array.isArray(arr) ? arr[i] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const bars: DailyBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    const adjusted = toNum(adj0?.adjclose, i);
    bars.push({
      date: isoDate(ts, offsetSec),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      open: toNum(q0!.open, i),
      high: toNum(q0!.high, i),
      low: toNum(q0!.low, i),
      close: toNum(q0!.close, i),
      adjustedClose: adjusted,
      volume: toNum(q0!.volume, i),
    });
  }
  if (bars.length === 0) {
    throw new Error(`yahoo chart for ${symbol}: no bars`);
  }
  return bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Parse the Yahoo `events` block (dividends + splits) into normalized corporate
// action records. The block is keyed by epoch-second timestamp; each entry has
// a `date` (ex-date epoch seconds) plus `amount` (dividend) or
// `numerator`/`denominator` (split). Returns [] when no events were emitted.
export function parseCorporateActions(
  payload: unknown,
  symbol: string,
  source: string,
  runId: string,
  fetchedAt: string,
  securityId: string,
): CorporateAction[] {
  const chart = asRecord(payload)?.chart as unknown;
  const result = asRecord(chart)?.result as unknown;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  if (!first) return [];
  const meta = asRecord(first.meta);
  const offsetSec = typeof meta?.gmtoffset === "number" ? meta.gmtoffset : 0;
  const events = asRecord(first.events);
  if (!events) return [];

  const out: CorporateAction[] = [];
  const dividends = asRecord(events.dividends);
  if (dividends) {
    for (const key of Object.keys(dividends)) {
      const rec = asRecord(dividends[key]);
      if (!rec) continue;
      const date = typeof rec.date === "number" ? rec.date : Number(key);
      const amount = typeof rec.amount === "number" ? rec.amount : null;
      out.push({
        security_id: securityId,
        ticker: symbol,
        action_type: "DIVIDEND",
        ex_date: isoDate(date, offsetSec),
        numerator: null,
        denominator: null,
        amount,
        source,
        run_id: runId,
        fetched_at: fetchedAt,
      });
    }
  }
  const splits = asRecord(events.splits);
  if (splits) {
    for (const key of Object.keys(splits)) {
      const rec = asRecord(splits[key]);
      if (!rec) continue;
      const date = typeof rec.date === "number" ? rec.date : Number(key);
      const numerator = typeof rec.numerator === "number" ? rec.numerator : null;
      const denominator = typeof rec.denominator === "number" ? rec.denominator : null;
      out.push({
        security_id: securityId,
        ticker: symbol,
        action_type: "SPLIT",
        ex_date: isoDate(date, offsetSec),
        numerator,
        denominator,
        amount: null,
        source,
        run_id: runId,
        fetched_at: fetchedAt,
      });
    }
  }
  return out;
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
// 30- and 90-trading-day windows. Returns are taken off the ADJUSTED close
// (falling back to raw close when adjclose is unavailable) so a split does not
// inject a spurious return into volatility.
export function realizedVols(bars: DailyBar[]): RealizedVolResult {
  const closes = bars
    .map((b) => {
      const adj = typeof b.adjustedClose === "number" && Number.isFinite(b.adjustedClose) && b.adjustedClose > 0
        ? b.adjustedClose
        : b.close;
      return adj;
    })
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
// Normalize (records exactly follow *_FIELDS order)
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

export function normalizeCorporateActionRecords(
  actions: CorporateAction[],
): Array<Record<string, unknown>> {
  return actions.map((a) => {
    const rec: Record<string, unknown> = {
      security_id: a.security_id, ticker: a.ticker, action_type: a.action_type,
      ex_date: a.ex_date, numerator: a.numerator, denominator: a.denominator,
      amount: a.amount, source: a.source, run_id: a.run_id, fetched_at: a.fetched_at,
    };
    const out: Record<string, unknown> = {};
    for (const f of CORPORATE_ACTION_FIELDS) out[f] = rec[f];
    return out;
  });
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

// Yahoo uses `-` (not `.`) as the share-class separator (BRK-B, BF-B), while the
// S&P 500 manifest uses the exchange form (BRK.B). Requests use the Yahoo form;
// published records keep the original symbol.
function yahooChartSymbol(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

// Build the Yahoo chart URL. Substitutes {symbol} (with the Yahoo share-class
// form) and, when a window is given, {period1}/{period2} (the range template).
// Without a window, the range=1y template is used.
function buildOhlcUrl(symbol: string, env: OhlcEnv, window?: OhlcWindow): string {
  const template = env.OHLC_URL_TEMPLATE
    || (window ? DEFAULT_OHLC_RANGE_TEMPLATE : DEFAULT_OHLC_URL_TEMPLATE);
  let url = template.replace("{symbol}", encodeURIComponent(yahooChartSymbol(symbol)));
  if (window) {
    url = url.replace("{period1}", String(Math.floor(window.period1)))
             .replace("{period2}", String(Math.floor(window.period2)));
  }
  return url;
}

// GET a Yahoo chart with retry/backoff parity with fetchChain() in run-symbols.
async function fetchOhlc(symbol: string, env: OhlcEnv, window?: OhlcWindow): Promise<unknown> {
  const url = buildOhlcUrl(symbol, env, window);
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
// Entry points
// ---------------------------------------------------------------------------
export interface OhlcRunResult {
  symbol: string;
  security_id: string;
  bar_count: number;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
  published_ohlc: boolean;
  published_realized_vol: boolean;
  published_corporate_actions: boolean;
  corporate_action_count: number;
}

function resolveSecurityId(env: OhlcEnv, symbol: string, explicit?: string): string {
  if (explicit) return explicit;
  if (env.securityIdFor) {
    const id = env.securityIdFor(symbol);
    if (id) return id;
  }
  return symbol;
}

// Fetch + normalize + publish one symbol's OHLC, realized-vol snapshot, and
// corporate actions for an arbitrary window. Shared by publishOhlc (window
// omitted -> range=1y daily) and publishOhlcRange (explicit backfill window).
// securityId defaults to the symbol (or env.securityIdFor) when not given.
async function publishOhlcInternal(
  symbol: string,
  env: OhlcEnv,
  window: OhlcWindow | undefined,
  explicitSecurityId?: string,
): Promise<OhlcRunResult> {
  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const asOfDate = fetchedAt.slice(0, 10);
  const source = env.OHLC_SOURCE || "yahoo";
  const securityId = resolveSecurityId(env, symbol, explicitSecurityId);

  const payload = await fetchOhlc(symbol, env, window);
  const bars = parseYahooChart(payload, symbol);
  const rv = realizedVols(bars);
  const actions = parseCorporateActions(
    payload, symbol, source, runId, fetchedAt, securityId,
  );

  const ohlcRecords = normalizeOhlcRecords(
    symbol, bars, source, runId, asOfDate, fetchedAt,
  );
  const rvRecord = normalizeRealizedVolRecord(symbol, rv, runId, fetchedAt);
  const caRecords = normalizeCorporateActionRecords(actions);

  const ohlcUrl = env.PIPELINE_OHLC_URL || "";
  const rvUrl = env.PIPELINE_REALIZED_VOL_URL || "";
  const caUrl = env.PIPELINE_CORPORATE_ACTIONS_URL || "";
  const authToken = env.PIPELINE_AUTH_TOKEN || "";

  let publishedOhlc = false;
  let publishedRv = false;
  let publishedCa = false;
  if (ohlcUrl) {
    await requestJson(ohlcUrl, ohlcRecords, `${runId}:ohlc:${symbol}`, authToken, env);
    publishedOhlc = true;
  }
  if (rvUrl) {
    await requestJson(rvUrl, rvRecord, `${runId}:rv:${symbol}`, authToken, env);
    publishedRv = true;
  }
  if (caUrl && caRecords.length > 0) {
    await requestJson(caUrl, caRecords, `${runId}:ca:${symbol}`, authToken, env);
    publishedCa = true;
  }

  return {
    symbol,
    security_id: securityId,
    bar_count: bars.length,
    realized_vol_30d: rv.realized_vol_30d,
    realized_vol_90d: rv.realized_vol_90d,
    published_ohlc: publishedOhlc,
    published_realized_vol: publishedRv,
    published_corporate_actions: publishedCa,
    corporate_action_count: actions.length,
  };
}

// Daily (range=1y) publish — the ohlc-daily job's per-symbol path.
export async function publishOhlc(symbol: string, env: OhlcEnv = {}): Promise<OhlcRunResult> {
  return publishOhlcInternal(symbol, env, undefined);
}

// Backfill publish over an explicit epoch-second window. No-op (dry-run) for
// the local probe: it still fetches + normalizes, but only publishes when the
// Pipeline URLs are set.
export async function publishOhlcRange(
  symbol: string,
  period1: number,
  period2: number,
  env: OhlcEnv = {},
  securityId?: string,
): Promise<OhlcRunResult> {
  return publishOhlcInternal(symbol, env, { period1, period2 }, securityId);
}
