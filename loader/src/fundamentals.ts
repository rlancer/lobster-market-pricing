// Equity fundamentals for the options lake (market cap, PE, debt, margins).
//
// Yahoo quoteSummary modules summaryDetail / defaultKeyStatistics / financialData
// — same fields the Worker research brief used to live-scrape. Append-only into
// options.fundamentals; consumers keep the newest row per ticker (latest-wins).
//
// Reuses the Yahoo crumb+cookie session helpers from etf.ts (chart v8 does not
// need a crumb; quoteSummary does).

import { securityIdForTicker } from "./symbology.js";
import {
  DEFAULT_YAHOO_USER_AGENT,
  HTTP_RETRIES_DEFAULT,
  REQUEST_TIMEOUT_SECONDS_DEFAULT,
  RETRY_BACKOFF_SECONDS_DEFAULT,
  openYahooSession,
  type YahooSession,
} from "./etf.js";

export const FUNDAMENTALS_SOURCE = "yahoo";

export const DEFAULT_FUNDAMENTALS_QUOTE_SUMMARY_TEMPLATE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}" +
  "?modules=summaryDetail,defaultKeyStatistics,financialData&crumb={crumb}";

export const FUNDAMENTALS_FIELDS = [
  "ticker",
  "security_id",
  "market_cap",
  "enterprise_value",
  "trailing_pe",
  "forward_pe",
  "peg_ratio",
  "price_to_book",
  "total_debt",
  "debt_to_equity",
  "profit_margins",
  "revenue_growth",
  "source",
  "fetched_at",
] as const;

export interface FundamentalsEnv {
  PIPELINE_FUNDAMENTALS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  YAHOO_USER_AGENT?: string;
  YAHOO_COOKIE_URL?: string;
  YAHOO_CRUMB_URL?: string;
  YAHOO_QUOTE_SUMMARY_TEMPLATE?: string;
  yahooSession?: YahooSession;
  now?: () => Date;
  runId?: () => string;
}

export interface FundamentalsRow {
  ticker: string;
  security_id: string;
  market_cap: number | null;
  enterprise_value: number | null;
  trailing_pe: number | null;
  forward_pe: number | null;
  peg_ratio: number | null;
  price_to_book: number | null;
  total_debt: number | null;
  debt_to_equity: number | null;
  profit_margins: number | null;
  revenue_growth: number | null;
  source: string;
  fetched_at: string;
}

export interface FundamentalsPublishResult {
  ticker: string;
  published: boolean;
  run_id: string;
}

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffSeconds(env: FundamentalsEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
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

function project(
  rec: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = rec[f];
  return out;
}

/** Yahoo quoteSummary uses dashes for class shares (BRK.B → BRK-B). */
export function yahooSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\./g, "-");
}

export function parseFundamentalsQuoteSummary(
  payload: unknown,
  ticker: string,
  fetchedAt: string,
): FundamentalsRow {
  const root = asRecord(payload);
  const qs = asRecord(root?.quoteSummary);
  const err = asRecord(qs?.error);
  if (err && typeof err.description === "string" && err.description) {
    throw new Error(`yahoo quoteSummary ${ticker}: ${err.description}`);
  }
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) throw new Error(`yahoo quoteSummary ${ticker}: empty result`);

  const summary = asRecord(result.summaryDetail);
  const stats = asRecord(result.defaultKeyStatistics);
  const financial = asRecord(result.financialData);

  return {
    ticker,
    security_id: securityIdForTicker(ticker),
    market_cap: rawNum(summary?.marketCap),
    enterprise_value: rawNum(stats?.enterpriseValue),
    trailing_pe: rawNum(summary?.trailingPE) ?? rawNum(stats?.trailingPE),
    forward_pe: rawNum(summary?.forwardPE) ?? rawNum(stats?.forwardPE),
    peg_ratio: rawNum(stats?.pegRatio),
    price_to_book: rawNum(stats?.priceToBook),
    total_debt: rawNum(financial?.totalDebt),
    debt_to_equity: rawNum(financial?.debtToEquity),
    profit_margins: rawNum(financial?.profitMargins),
    revenue_growth: rawNum(financial?.revenueGrowth),
    source: FUNDAMENTALS_SOURCE,
    fetched_at: fetchedAt,
  };
}

async function fetchQuoteSummary(
  symbol: string,
  session: YahooSession,
  env: FundamentalsEnv,
): Promise<unknown> {
  const template =
    env.YAHOO_QUOTE_SUMMARY_TEMPLATE || DEFAULT_FUNDAMENTALS_QUOTE_SUMMARY_TEMPLATE;
  const url = template
    .replace("{symbol}", encodeURIComponent(yahooSymbol(symbol)))
    .replace("{crumb}", encodeURIComponent(session.crumb));
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const ua = env.YAHOO_USER_AGENT || DEFAULT_YAHOO_USER_AGENT;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": ua,
          cookie: session.cookie,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      const code = response.status;
      const detail = await response.text();
      lastError = new Error(`yahoo quoteSummary HTTP ${code}: ${detail.slice(0, 160)}`);
      if (code === 401 || (code !== 408 && code !== 429 && code < 500)) throw lastError;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`yahoo quoteSummary failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: FundamentalsEnv,
): Promise<void> {
  if (!url) return;
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const body = JSON.stringify(stripNones(payload));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
  };
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
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
  throw new Error(`pipeline request failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

export async function publishFundamentals(
  symbol: string,
  env: FundamentalsEnv = {},
  session?: YahooSession,
): Promise<FundamentalsPublishResult> {
  const url = env.PIPELINE_FUNDAMENTALS_URL || "";
  if (!url) {
    throw new Error("fundamentals publish requires PIPELINE_FUNDAMENTALS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const sess = session ?? (env.yahooSession ?? await openYahooSession(env));
  const payload = await fetchQuoteSummary(symbol, sess, env);
  const row = parseFundamentalsQuoteSummary(payload, symbol, fetchedAt);
  await requestJson(
    url,
    [project(row as unknown as Record<string, unknown>, FUNDAMENTALS_FIELDS)],
    `fundamentals:${runId}:${symbol}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return { ticker: symbol, published: true, run_id: runId };
}
