// ETF fund-profile + top-holdings enrichment for the options lake.
//
// Yahoo chart v8 already lands ETF distributions in options.corporate_actions
// (same events=div,split path as equities). This module adds the facts that
// path does not carry:
//   - options.etf_profiles  — expense ratio, AUM, issuer, category, yield
//   - options.etf_holdings  — Yahoo's top-10 book (not the full portfolio)
//
// quoteSummary requires a Yahoo crumb+cookie session (chart v8 does not).
// The session is opened once per job pass and reused across the ETF universe.

import { securityIdForTicker } from "./symbology.js";

export const DEFAULT_YAHOO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const DEFAULT_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
export const DEFAULT_COOKIE_URL = "https://fc.yahoo.com";
export const DEFAULT_QUOTE_SUMMARY_TEMPLATE =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}?modules=fundProfile,topHoldings,summaryDetail,defaultKeyStatistics&crumb={crumb}";

export const ETF_SOURCE = "yahoo";

export const ETF_PROFILE_FIELDS = [
  "ticker", "security_id", "name", "family", "category", "legal_type",
  "asset_class", "expense_ratio", "net_expense_ratio", "net_assets",
  "trailing_yield", "inception_date", "source", "run_id", "as_of_date",
  "fetched_at",
] as const;

export const ETF_HOLDING_FIELDS = [
  "ticker", "security_id", "rank", "holding_symbol", "holding_name", "weight",
  "source", "run_id", "as_of_date", "fetched_at",
] as const;

export const HTTP_RETRIES_DEFAULT = 3;
export const RETRY_BACKOFF_SECONDS_DEFAULT = 1;
export const REQUEST_TIMEOUT_SECONDS_DEFAULT = 20;

export interface EtfEnv {
  PIPELINE_ETF_PROFILES_URL?: string;
  PIPELINE_ETF_HOLDINGS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  YAHOO_USER_AGENT?: string;
  YAHOO_COOKIE_URL?: string;
  YAHOO_CRUMB_URL?: string;
  YAHOO_QUOTE_SUMMARY_TEMPLATE?: string;
  // Test seams: skip the live crumb handshake.
  yahooSession?: YahooSession;
  now?: () => Date;
  runId?: () => string;
}

export interface YahooSession {
  cookie: string;
  crumb: string;
}

export interface EtfProfile {
  ticker: string;
  security_id: string;
  name: string | null;
  family: string | null;
  category: string | null;
  legal_type: string | null;
  asset_class: string | null;
  expense_ratio: number | null;
  net_expense_ratio: number | null;
  net_assets: number | null;
  trailing_yield: number | null;
  inception_date: string | null;
  source: string;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

export interface EtfHolding {
  ticker: string;
  security_id: string;
  rank: number;
  holding_symbol: string | null;
  holding_name: string | null;
  weight: number | null;
  source: string;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

export interface EtfPublishResult {
  ticker: string;
  published_profile: boolean;
  published_holdings: boolean;
  holding_count: number;
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

function backoffSeconds(env: EtfEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function cookieFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  }
  const one = headers.get("set-cookie");
  return one ? one.split(";")[0] : "";
}

function inceptionDate(stats: Record<string, unknown> | null): string | null {
  const rec = asRecord(stats?.fundInceptionDate);
  const fmt = rec && typeof rec.fmt === "string" ? rec.fmt.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  const raw = rec && typeof rec.raw === "number" ? rec.raw : null;
  if (raw == null || !Number.isFinite(raw)) return null;
  const d = new Date(raw * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

function project<T extends readonly string[]>(
  rec: Record<string, unknown>,
  fields: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = rec[f];
  return out;
}

export function parseQuoteSummary(
  payload: unknown,
  ticker: string,
  meta: { name?: string; asset_class?: string },
  runId: string,
  fetchedAt: string,
): { profile: EtfProfile; holdings: EtfHolding[] } {
  const root = asRecord(payload);
  const qs = asRecord(root?.quoteSummary);
  const err = asRecord(qs?.error);
  if (err && typeof err.description === "string" && err.description) {
    throw new Error(`yahoo quoteSummary ${ticker}: ${err.description}`);
  }
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) throw new Error(`yahoo quoteSummary ${ticker}: empty result`);

  const fund = asRecord(result.fundProfile);
  const fees = asRecord(fund?.feesExpensesInvestment);
  const stats = asRecord(result.defaultKeyStatistics);
  const detail = asRecord(result.summaryDetail);
  const top = asRecord(result.topHoldings);
  const asOfDate = fetchedAt.slice(0, 10);
  const securityId = securityIdForTicker(ticker);

  const profile: EtfProfile = {
    ticker,
    security_id: securityId,
    name: (typeof meta.name === "string" && meta.name.trim()) || ticker,
    family: typeof fund?.family === "string" ? fund.family : null,
    category: typeof fund?.categoryName === "string" ? fund.categoryName : null,
    legal_type: typeof fund?.legalType === "string" ? fund.legalType : null,
    asset_class: typeof meta.asset_class === "string" && meta.asset_class.trim() ? meta.asset_class : null,
    expense_ratio: rawNum(fees?.annualReportExpenseRatio),
    net_expense_ratio: rawNum(fees?.netExpRatio),
    net_assets: rawNum(stats?.totalAssets) ?? rawNum(fees?.totalNetAssets),
    trailing_yield: rawNum(detail?.yield) ?? rawNum(detail?.trailingAnnualDividendYield),
    inception_date: inceptionDate(stats),
    source: ETF_SOURCE,
    run_id: runId,
    as_of_date: asOfDate,
    fetched_at: fetchedAt,
  };

  const rows = Array.isArray(top?.holdings) ? top.holdings : [];
  const holdings: EtfHolding[] = [];
  rows.forEach((row, idx) => {
    const rec = asRecord(row);
    if (!rec) return;
    const holdingSymbol = typeof rec.symbol === "string" && rec.symbol.trim() ? rec.symbol.trim().toUpperCase() : null;
    const holdingName = typeof rec.holdingName === "string" && rec.holdingName.trim() ? rec.holdingName.trim() : null;
    holdings.push({
      ticker,
      security_id: securityId,
      rank: idx + 1,
      holding_symbol: holdingSymbol,
      holding_name: holdingName,
      weight: rawNum(rec.holdingPercent),
      source: ETF_SOURCE,
      run_id: runId,
      as_of_date: asOfDate,
      fetched_at: fetchedAt,
    });
  });

  return { profile, holdings };
}

export async function openYahooSession(env: EtfEnv = {}): Promise<YahooSession> {
  if (env.yahooSession) return env.yahooSession;
  const ua = env.YAHOO_USER_AGENT || DEFAULT_YAHOO_USER_AGENT;
  const cookieUrl = env.YAHOO_COOKIE_URL || DEFAULT_COOKIE_URL;
  const crumbUrl = env.YAHOO_CRUMB_URL || DEFAULT_CRUMB_URL;
  const cookieRes = await fetch(cookieUrl, {
    headers: { "user-agent": ua },
    redirect: "manual",
  });
  const cookie = cookieFrom(cookieRes);
  if (!cookie) throw new Error("yahoo session: no cookie from fc.yahoo.com");
  const crumbRes = await fetch(crumbUrl, {
    headers: { "user-agent": ua, cookie },
  });
  if (!crumbRes.ok) {
    throw new Error(`yahoo crumb HTTP ${crumbRes.status}: ${(await crumbRes.text()).slice(0, 120)}`);
  }
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith("{") || crumb.startsWith("<") || crumb.length > 80) {
    throw new Error("yahoo session: invalid crumb");
  }
  return { cookie, crumb };
}

async function fetchQuoteSummary(
  symbol: string,
  session: YahooSession,
  env: EtfEnv,
): Promise<unknown> {
  const template = env.YAHOO_QUOTE_SUMMARY_TEMPLATE || DEFAULT_QUOTE_SUMMARY_TEMPLATE;
  const url = template
    .replace("{symbol}", encodeURIComponent(symbol))
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
  env: EtfEnv,
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

export async function publishEtf(
  symbol: string,
  env: EtfEnv = {},
  meta: { name?: string; asset_class?: string } = {},
  session?: YahooSession,
): Promise<EtfPublishResult> {
  const profilesUrl = env.PIPELINE_ETF_PROFILES_URL || "";
  const holdingsUrl = env.PIPELINE_ETF_HOLDINGS_URL || "";
  if (!profilesUrl && !holdingsUrl) {
    throw new Error("etf publish requires PIPELINE_ETF_PROFILES_URL or PIPELINE_ETF_HOLDINGS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const sess = session ?? await openYahooSession(env);
  const payload = await fetchQuoteSummary(symbol, sess, env);
  const { profile, holdings } = parseQuoteSummary(payload, symbol, meta, runId, fetchedAt);
  const auth = env.PIPELINE_AUTH_TOKEN || "";

  let publishedProfile = false;
  let publishedHoldings = false;
  if (profilesUrl) {
    await requestJson(
      profilesUrl,
      [project(profile as unknown as Record<string, unknown>, ETF_PROFILE_FIELDS)],
      `etf-profile:${runId}:${symbol}`,
      auth,
      env,
    );
    publishedProfile = true;
  }
  if (holdingsUrl && holdings.length > 0) {
    await requestJson(
      holdingsUrl,
      holdings.map((h) => project(h as unknown as Record<string, unknown>, ETF_HOLDING_FIELDS)),
      `etf-holdings:${runId}:${symbol}`,
      auth,
      env,
    );
    publishedHoldings = true;
  }
  return {
    ticker: symbol,
    published_profile: publishedProfile,
    published_holdings: publishedHoldings,
    holding_count: holdings.length,
    run_id: runId,
  };
}
