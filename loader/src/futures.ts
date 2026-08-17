// Cboe Futures Exchange (CFE) settlements + delayed quotes for the options lake.
//
// Two free CBOE surfaces (no key):
//   - Daily settlement CSV → options.futures_settlements
//       https://www.cboe.com/us/futures/market_statistics/settlement/csv
//   - Delayed quotes for monthals → options.futures_quotes
//       https://cdn.cboe.com/api/global/delayed_quotes/quotes/{ROOT}{M}{YY}.json
//
// CME/CBOT continuous Yahoo bars (ES=F, …) live in futures-ohlc-daily and reuse
// options.ohlc — this module is CFE-only (VX, VXM, FBT, IBHY, …).
//
// Pure module (global fetch / crypto only), same retry + Pipeline-publish style
// as earnings.ts / etf.ts.

export const DEFAULT_SETTLEMENT_CSV_URL =
  "https://www.cboe.com/us/futures/market_statistics/settlement/csv";
export const DEFAULT_QUOTE_URL_TEMPLATE =
  "https://cdn.cboe.com/api/global/delayed_quotes/quotes/{symbol}.json";
export const DEFAULT_FUTURES_ROOTS_URL =
  "https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/futures-roots.json";

export const CFE_SOURCE = "cboe";

export const FUTURES_SETTLEMENT_FIELDS = [
  "product", "contract_symbol", "expiration_date", "settle_price",
  "source", "run_id", "as_of_date", "fetched_at",
] as const;

export const FUTURES_QUOTE_FIELDS = [
  "root", "contract_symbol", "security_type", "expiration_date",
  "last", "bid", "ask", "open", "high", "low", "close", "prev_close",
  "volume", "open_interest", "settlement_price",
  "source", "run_id", "as_of_date", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export const CFE_PASS_SETTLEMENTS = "settlements";
export const CFE_PASS_QUOTES = "quotes";

export interface FuturesEnv {
  PIPELINE_FUTURES_SETTLEMENTS_URL?: string;
  PIPELINE_FUTURES_QUOTES_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  CFE_SETTLEMENT_CSV_URL?: string;
  CFE_QUOTE_URL_TEMPLATE?: string;
  CFE_FUTURES_ROOTS_URL?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  now?: () => Date;
  runId?: () => string;
}

export interface FuturesSettlementRow {
  product: string;
  contract_symbol: string;
  expiration_date: string;
  settle_price: number | null;
  source: string;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

export interface FuturesQuoteRow {
  root: string;
  contract_symbol: string;
  security_type: string | null;
  expiration_date: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prev_close: number | null;
  volume: number | null;
  open_interest: number | null;
  settlement_price: number | null;
  source: string;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

export interface FuturesPublishResult {
  pass: string;
  row_count: number;
  published: boolean;
  run_id: string;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function num(v: number | undefined, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffSeconds(env: FuturesEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intOrNull(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n === null ? null : Math.trunc(n);
}

function stripNones(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Settlement symbols look like "VX/U6" (monthly) or "VX34/Q6" (weekly).
// Only monthals map to the delayed-quotes URL shape ROOT+M+YY (e.g. VXU26).
const MONTHLY_SETTLE_RE = /^([A-Z0-9]+)\/([FGHJKMNQUVXZ])(\d)$/;

export function settlementToQuoteSymbol(
  product: string,
  contractSymbol: string,
  now: Date = new Date(),
): string | null {
  const m = contractSymbol.match(MONTHLY_SETTLE_RE);
  if (!m) return null;
  const [, root, month, yDigit] = m;
  if (root !== product) return null; // weeklies use VX34/… while product is VX
  const digit = Number(yDigit);
  if (!Number.isFinite(digit)) return null;
  const currentYear = now.getUTCFullYear();
  let year = Math.floor(currentYear / 10) * 10 + digit;
  // Single-digit CFE year codes wrap each decade (…6=2026, …7=2027, …0=2030).
  if (year < currentYear - 2) year += 10;
  return `${root}${month}${String(year).slice(-2)}`;
}

export function parseSettlementCsv(
  csv: string,
  runId: string,
  asOfDate: string,
  fetchedAt: string,
): FuturesSettlementRow[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = {
    product: header.indexOf("product"),
    symbol: header.indexOf("symbol"),
    expiration: header.indexOf("expiration date"),
    price: header.indexOf("price"),
  };
  if (idx.product < 0 || idx.symbol < 0 || idx.expiration < 0 || idx.price < 0) {
    throw new Error(`settlement CSV missing required columns: got ${header.join(",")}`);
  }
  const rows: FuturesSettlementRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const product = (cols[idx.product] || "").trim();
    const contract_symbol = (cols[idx.symbol] || "").trim();
    const expiration_date = (cols[idx.expiration] || "").trim();
    if (!product || !contract_symbol || !expiration_date) continue;
    rows.push({
      product,
      contract_symbol,
      expiration_date,
      settle_price: finiteOrNull(cols[idx.price]),
      source: CFE_SOURCE,
      run_id: runId,
      as_of_date: asOfDate,
      fetched_at: fetchedAt,
    });
  }
  return rows;
}

export function normalizeQuotePayload(
  payload: unknown,
  root: string,
  runId: string,
  asOfDate: string,
  fetchedAt: string,
): FuturesQuoteRow {
  const top = asRecord(payload) || {};
  const data = asRecord(top.data) || top;
  const settleRaw = data.settlement_date;
  let expiration_date: string | null = null;
  if (typeof settleRaw === "string" && settleRaw.length >= 10) {
    expiration_date = settleRaw.slice(0, 10);
  }
  const contract_symbol = String(data.symbol || top.symbol || "").trim();
  if (!contract_symbol) throw new Error("quote payload missing symbol");
  return {
    root,
    contract_symbol,
    security_type: typeof data.security_type === "string" ? data.security_type : null,
    expiration_date,
    last: finiteOrNull(data.current_price),
    bid: finiteOrNull(data.bid),
    ask: finiteOrNull(data.ask),
    open: finiteOrNull(data.open),
    high: finiteOrNull(data.high),
    low: finiteOrNull(data.low),
    close: finiteOrNull(data.close),
    prev_close: finiteOrNull(data.prev_day_close),
    volume: intOrNull(data.volume),
    open_interest: finiteOrNull(data.open_interest),
    settlement_price: finiteOrNull(data.settlement_price),
    source: CFE_SOURCE,
    run_id: runId,
    as_of_date: asOfDate,
    fetched_at: fetchedAt,
  };
}

async function requestText(url: string, env: FuturesEnv): Promise<string> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "cboe-to-r2/0.2" },
        signal: controller.signal,
      });
      if (response.ok) return await response.text();
      const code = response.status;
      lastError = new Error(`CFE source returned HTTP ${code}`);
      if (code !== 408 && code !== 429 && code < 500) throw lastError;
      if (attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after") || "0");
        await sleep(Math.max(backoffSeconds(env, attempt), Number.isFinite(retryAfter) ? retryAfter : 0) * 1000);
      }
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`CFE request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

async function requestJson(url: string, env: FuturesEnv): Promise<unknown> {
  const text = await requestText(url, env);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`CFE JSON parse failed: ${errMsg(error)}`);
  }
}

async function publishRows(
  url: string,
  rows: Array<Record<string, unknown>>,
  idempotencyKey: string,
  env: FuturesEnv,
): Promise<void> {
  if (!url) return;
  if (rows.length === 0) return;
  const authToken = env.PIPELINE_AUTH_TOKEN || "";
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(rows));
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
    if (code < 500) throw lastError;
    if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
  }
  throw new Error(
    `pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`,
  );
}

export function cfePassList(): string[] {
  return [CFE_PASS_SETTLEMENTS, CFE_PASS_QUOTES];
}

export async function fetchSettlementRows(env: FuturesEnv): Promise<FuturesSettlementRow[]> {
  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const asOfDate = isoDate(new Date(fetchedAt));
  const url = env.CFE_SETTLEMENT_CSV_URL || DEFAULT_SETTLEMENT_CSV_URL;
  const csv = await requestText(url, env);
  return parseSettlementCsv(csv, runId, asOfDate, fetchedAt);
}

export async function fetchQuoteRows(
  settlements: FuturesSettlementRow[],
  env: FuturesEnv,
): Promise<FuturesQuoteRow[]> {
  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const now = env.now ? env.now() : new Date();
  const fetchedAt = now.toISOString();
  const asOfDate = isoDate(now);
  const template = env.CFE_QUOTE_URL_TEMPLATE || DEFAULT_QUOTE_URL_TEMPLATE;

  const wanted = new Map<string, string>(); // quoteSymbol → root
  for (const row of settlements) {
    const quoteSym = settlementToQuoteSymbol(row.product, row.contract_symbol, now);
    if (!quoteSym) continue;
    wanted.set(quoteSym, row.product);
  }

  const out: FuturesQuoteRow[] = [];
  for (const [symbol, root] of wanted) {
    const url = template.replace("{symbol}", encodeURIComponent(symbol));
    try {
      const payload = await requestJson(url, env);
      out.push(normalizeQuotePayload(payload, root, runId, asOfDate, fetchedAt));
    } catch (error) {
      // Monthals can 403 when the CDN has no book — skip without failing the pass.
      const msg = errMsg(error);
      if (/HTTP 403|HTTP 404/.test(msg)) continue;
      throw error;
    }
  }
  return out;
}

export async function publishCfePass(
  pass: string,
  env: FuturesEnv,
): Promise<FuturesPublishResult> {
  const runId = env.runId ? env.runId() : crypto.randomUUID();
  const passEnv: FuturesEnv = { ...env, runId: () => runId };

  if (pass === CFE_PASS_SETTLEMENTS) {
    const url = env.PIPELINE_FUTURES_SETTLEMENTS_URL || "";
    if (!url) {
      throw new Error("cfe settlements publish requires PIPELINE_FUTURES_SETTLEMENTS_URL");
    }
    const rows = await fetchSettlementRows(passEnv);
    await publishRows(
      url,
      rows as unknown as Array<Record<string, unknown>>,
      `${runId}:futures-settlements`,
      passEnv,
    );
    return { pass, row_count: rows.length, published: true, run_id: runId };
  }

  if (pass === CFE_PASS_QUOTES) {
    const url = env.PIPELINE_FUTURES_QUOTES_URL || "";
    if (!url) {
      throw new Error("cfe quotes publish requires PIPELINE_FUTURES_QUOTES_URL");
    }
    // Quotes need the settlement book to know which monthals to request.
    const settlements = await fetchSettlementRows(passEnv);
    const rows = await fetchQuoteRows(settlements, passEnv);
    await publishRows(
      url,
      rows as unknown as Array<Record<string, unknown>>,
      `${runId}:futures-quotes`,
      passEnv,
    );
    return { pass, row_count: rows.length, published: true, run_id: runId };
  }

  throw new Error(`unknown cfe-futures pass: ${pass}`);
}
