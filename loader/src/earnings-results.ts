// Reported earnings results (actual vs estimate) for the options lake.
//
// Yahoo quoteSummary module `earningsHistory` — last ~4 quarters of EPS
// actual / estimate / surprise. Append-only into options.earnings_results;
// consumers keep the newest row per (symbol, quarter_end) (latest-wins).
//
// Complements options.earnings (Nasdaq calendar / upcoming estimates).

import { securityIdForTicker } from "./symbology.js";
import {
  DEFAULT_YAHOO_USER_AGENT,
  HTTP_RETRIES_DEFAULT,
  REQUEST_TIMEOUT_SECONDS_DEFAULT,
  RETRY_BACKOFF_SECONDS_DEFAULT,
  openYahooSession,
  type YahooSession,
} from "./etf.js";
import { yahooSymbol } from "./fundamentals.js";

export const EARNINGS_RESULTS_SOURCE = "yahoo";

export const DEFAULT_EARNINGS_RESULTS_QUOTE_SUMMARY_TEMPLATE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}" +
  "?modules=earningsHistory&crumb={crumb}";

export const EARNINGS_RESULTS_FIELDS = [
  "symbol",
  "security_id",
  "quarter_end",
  "period_label",
  "eps_actual",
  "eps_estimate",
  "eps_difference",
  "surprise_pct",
  "currency",
  "source",
  "run_id",
  "fetched_at",
] as const;

export interface EarningsResultsEnv {
  PIPELINE_EARNINGS_RESULTS_URL?: string;
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

export interface EarningsResultRow {
  symbol: string;
  security_id: string;
  quarter_end: string;
  period_label: string | null;
  eps_actual: number | null;
  eps_estimate: number | null;
  eps_difference: number | null;
  surprise_pct: number | null;
  currency: string | null;
  source: string;
  run_id: string;
  fetched_at: string;
}

export interface EarningsResultsPublishResult {
  symbol: string;
  row_count: number;
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

function backoffSeconds(env: EarningsResultsEnv, attempt: number): number {
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

function project(row: EarningsResultRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of EARNINGS_RESULTS_FIELDS) out[f] = row[f];
  return out;
}

/** Yahoo epoch seconds (or ms) → YYYY-MM-DD. */
export function quarterEndFromYahoo(value: unknown): string | null {
  const rec = asRecord(value);
  const fmt = typeof rec?.fmt === "string" ? rec.fmt.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}/.test(fmt)) return fmt.slice(0, 10);
  const raw = rawNum(value);
  if (raw == null) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function parseEarningsHistory(
  payload: unknown,
  symbol: string,
  runId: string,
  fetchedAt: string,
): EarningsResultRow[] {
  const root = asRecord(payload);
  const qs = asRecord(root?.quoteSummary);
  const err = asRecord(qs?.error);
  if (err && typeof err.description === "string" && err.description) {
    throw new Error(`yahoo quoteSummary ${symbol}: ${err.description}`);
  }
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) throw new Error(`yahoo quoteSummary ${symbol}: empty result`);

  const history = asRecord(result.earningsHistory);
  const rows = Array.isArray(history?.history) ? history.history : [];
  const out: EarningsResultRow[] = [];
  const seen = new Set<string>();

  for (const item of rows) {
    const rec = asRecord(item);
    if (!rec) continue;
    const quarterEnd = quarterEndFromYahoo(rec.quarter);
    if (!quarterEnd || seen.has(quarterEnd)) continue;
    seen.add(quarterEnd);
    const periodLabel =
      typeof rec.period === "string" && rec.period.trim() ? rec.period.trim() : null;
    out.push({
      symbol,
      security_id: securityIdForTicker(symbol),
      quarter_end: quarterEnd,
      period_label: periodLabel,
      eps_actual: rawNum(rec.epsActual),
      eps_estimate: rawNum(rec.epsEstimate),
      eps_difference: rawNum(rec.epsDifference),
      surprise_pct: rawNum(rec.surprisePercent),
      currency: typeof rec.currency === "string" ? rec.currency : null,
      source: EARNINGS_RESULTS_SOURCE,
      run_id: runId,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

async function fetchQuoteSummary(
  symbol: string,
  session: YahooSession,
  env: EarningsResultsEnv,
): Promise<unknown> {
  const template =
    env.YAHOO_QUOTE_SUMMARY_TEMPLATE || DEFAULT_EARNINGS_RESULTS_QUOTE_SUMMARY_TEMPLATE;
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
  env: EarningsResultsEnv,
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

export async function publishEarningsResults(
  symbol: string,
  env: EarningsResultsEnv = {},
  session?: YahooSession,
): Promise<EarningsResultsPublishResult> {
  const url = env.PIPELINE_EARNINGS_RESULTS_URL || "";
  if (!url) {
    throw new Error("earnings results publish requires PIPELINE_EARNINGS_RESULTS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const sess = session ?? (env.yahooSession ?? await openYahooSession(env));
  const payload = await fetchQuoteSummary(symbol, sess, env);
  const rows = parseEarningsHistory(payload, symbol, runId, fetchedAt);
  if (rows.length === 0) {
    return { symbol, row_count: 0, published: false, run_id: runId };
  }
  await requestJson(
    url,
    rows.map(project),
    `earnings_results:${runId}:${symbol}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return { symbol, row_count: rows.length, published: true, run_id: runId };
}
