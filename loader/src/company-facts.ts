// SEC companyfacts (XBRL) → options.company_facts for earnings quality research.
//
// Pulls key us-gaap tags (revenue, net income, OCF, diluted EPS, share-based
// compensation, long-term debt, cash, lease liabilities, interest expense) from
// data.sec.gov companyfacts. Prefer framed discrete periods so YTD cumulatives
// do not pollute quarterly rows. Append-only; consumers latest-wins on
// (ticker, period_end, period_type).

import { securityIdForTicker } from "./symbology.js";
import {
  DEFAULT_SEC_TICKERS_URL,
  DEFAULT_SEC_USER_AGENT,
  HTTP_RETRIES_DEFAULT,
  REQUEST_TIMEOUT_SECONDS_DEFAULT,
  RETRY_BACKOFF_SECONDS_DEFAULT,
  loadCikMap,
  padCik,
  type SecEnv,
} from "./sec.js";

export const COMPANY_FACTS_SOURCE = "edgar";

export const DEFAULT_COMPANY_FACTS_TEMPLATE =
  "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json";

/** Soft cap: recent framed periods only (avoid flooding the stream). */
export const DEFAULT_MAX_PERIODS = 12;

export const COMPANY_FACTS_FIELDS = [
  "ticker",
  "security_id",
  "cik",
  "period_end",
  "period_type",
  "fiscal_year",
  "form",
  "filed_at",
  "frame",
  "revenue",
  "net_income",
  "operating_cash_flow",
  "diluted_eps",
  "share_based_compensation",
  "long_term_debt",
  "long_term_debt_current",
  "cash",
  "operating_lease_liability",
  "finance_lease_liability",
  "interest_expense",
  "source",
  "run_id",
  "fetched_at",
] as const;

export type CompanyFactMetric =
  | "revenue"
  | "net_income"
  | "operating_cash_flow"
  | "diluted_eps"
  | "share_based_compensation"
  | "long_term_debt"
  | "long_term_debt_current"
  | "cash"
  | "operating_lease_liability"
  | "finance_lease_liability"
  | "interest_expense";

/** Ordered tag fallbacks per metric (first matching framed entry wins). */
export const METRIC_TAGS: Record<CompanyFactMetric, readonly string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
  ],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  operating_cash_flow: ["NetCashProvidedByUsedInOperatingActivities"],
  diluted_eps: ["EarningsPerShareDiluted"],
  share_based_compensation: [
    "AllocatedShareBasedCompensationExpense",
    "ShareBasedCompensation",
  ],
  long_term_debt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  long_term_debt_current: ["LongTermDebtCurrent"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "Cash"],
  operating_lease_liability: ["OperatingLeaseLiability"],
  finance_lease_liability: ["FinanceLeaseLiability"],
  interest_expense: ["InterestExpense", "InterestExpenseDebt"],
};

const BALANCE_SHEET_METRICS = new Set<CompanyFactMetric>([
  "long_term_debt",
  "long_term_debt_current",
  "cash",
  "operating_lease_liability",
  "finance_lease_liability",
]);

export interface CompanyFactsEnv {
  SEC_TICKERS_URL?: string;
  SEC_COMPANY_FACTS_TEMPLATE?: string;
  SEC_USER_AGENT?: string;
  PIPELINE_COMPANY_FACTS_URL?: string;
  PIPELINE_AUTH_TOKEN?: string;
  HTTP_RETRIES?: number;
  RETRY_BACKOFF_SECONDS?: number;
  REQUEST_TIMEOUT?: number;
  COMPANY_FACTS_MAX_PERIODS?: number;
  now?: () => Date;
  runId?: () => string;
  cikByTicker?: Map<string, string>;
}

export interface CompanyFactRow {
  ticker: string;
  security_id: string;
  cik: string;
  period_end: string;
  period_type: string;
  fiscal_year: number | null;
  form: string | null;
  filed_at: string | null;
  frame: string | null;
  revenue: number | null;
  net_income: number | null;
  operating_cash_flow: number | null;
  diluted_eps: number | null;
  share_based_compensation: number | null;
  long_term_debt: number | null;
  long_term_debt_current: number | null;
  cash: number | null;
  operating_lease_liability: number | null;
  finance_lease_liability: number | null;
  interest_expense: number | null;
  source: string;
  run_id: string;
  fetched_at: string;
}

export interface CompanyFactsPublishResult {
  ticker: string;
  cik: string | null;
  row_count: number;
  published: boolean;
  run_id: string;
}

interface FactPoint {
  end: string;
  val: number;
  fy: number | null;
  fp: string | null;
  form: string | null;
  filed: string | null;
  frame: string;
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
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function backoffSeconds(env: CompanyFactsEnv, attempt: number): number {
  return num(env.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS_DEFAULT) * 2 ** attempt;
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

function project(row: CompanyFactRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of COMPANY_FACTS_FIELDS) out[f] = row[f];
  return out;
}

/** Map SEC fp (+ optional frame) to a stable period_type label. */
export function periodTypeFromFp(fp: string | null | undefined, frame?: string | null): string {
  const f = (fp || "").trim().toUpperCase();
  if (f === "FY" || f === "Q1" || f === "Q2" || f === "Q3" || f === "Q4") return f;
  const fr = (frame || "").trim().toUpperCase();
  if (/Q1I?$/.test(fr) || /Q1$/.test(fr)) return "Q1";
  if (/Q2I?$/.test(fr) || /Q2$/.test(fr)) return "Q2";
  if (/Q3I?$/.test(fr) || /Q3$/.test(fr)) return "Q3";
  if (/Q4I?$/.test(fr) || /Q4$/.test(fr)) return "Q4";
  if (/^CY\d{4}I?$/.test(fr)) return "FY";
  return f || "UNK";
}

function preferInstantFrame(frame: string, metric: CompanyFactMetric): boolean {
  const isInstant = /I$/.test(frame);
  if (BALANCE_SHEET_METRICS.has(metric)) return isInstant;
  return !isInstant;
}

/**
 * Collect framed fact points for a us-gaap tag. Unframed YTD piles are skipped
 * so cumulative 10-Q year-to-date values do not masquerade as quarters.
 */
export function collectFramedPoints(
  tagPayload: unknown,
  metric: CompanyFactMetric,
): FactPoint[] {
  const rec = asRecord(tagPayload);
  const units = asRecord(rec?.units);
  if (!units) return [];
  const out: FactPoint[] = [];
  for (const unitKey of Object.keys(units)) {
    const arr = units[unitKey];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const e = asRecord(raw);
      if (!e) continue;
      const frame = typeof e.frame === "string" ? e.frame.trim() : "";
      if (!frame) continue;
      if (!preferInstantFrame(frame, metric)) continue;
      const end = typeof e.end === "string" ? e.end.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}/.test(end)) continue;
      const val = typeof e.val === "number" && Number.isFinite(e.val) ? e.val : null;
      if (val == null) continue;
      const form = typeof e.form === "string" ? e.form.trim().toUpperCase() : null;
      if (form && !/^10-[KQ]/.test(form)) continue;
      out.push({
        end: end.slice(0, 10),
        val,
        fy: typeof e.fy === "number" && Number.isFinite(e.fy) ? e.fy : null,
        fp: typeof e.fp === "string" ? e.fp.trim().toUpperCase() : null,
        form,
        filed: typeof e.filed === "string" ? e.filed.trim().slice(0, 10) : null,
        frame,
      });
    }
  }
  // Newest period_end first; stable within end by filed desc.
  out.sort((a, b) => {
    const endCmp = b.end.localeCompare(a.end);
    if (endCmp !== 0) return endCmp;
    return (b.filed || "").localeCompare(a.filed || "");
  });
  return out;
}

function pickMetricValue(
  usGaap: Record<string, unknown>,
  metric: CompanyFactMetric,
  byPeriod: Map<string, Partial<CompanyFactRow> & { period_end: string }>,
): void {
  for (const tag of METRIC_TAGS[metric]) {
    const points = collectFramedPoints(usGaap[tag], metric);
    if (!points.length) continue;
    for (const p of points) {
      const periodType = periodTypeFromFp(p.fp, p.frame);
      const key = `${p.end}|${periodType}`;
      let row = byPeriod.get(key);
      if (!row) {
        row = {
          period_end: p.end,
          period_type: periodType,
          fiscal_year: p.fy,
          form: p.form,
          filed_at: p.filed,
          frame: p.frame,
        };
        byPeriod.set(key, row);
      }
      if (row[metric] == null) {
        (row as Record<string, unknown>)[metric] = p.val;
      }
      // Prefer richer meta from income statement tags when present.
      if (!row.fiscal_year && p.fy != null) row.fiscal_year = p.fy;
      if (!row.form && p.form) row.form = p.form;
      if ((!row.filed_at || (p.filed && p.filed > row.filed_at)) && p.filed) {
        row.filed_at = p.filed;
      }
      if (!row.frame && p.frame) row.frame = p.frame;
    }
    // First tag with data is enough (fallback chain).
    return;
  }
}

/**
 * Parse companyfacts JSON into period rows. Only periods that carry at least
 * one P&L signal (revenue, net income, or diluted EPS) are kept so balance-
 * sheet-only instants do not dominate.
 */
export function parseCompanyFacts(
  payload: unknown,
  ticker: string,
  cik: string,
  runId: string,
  fetchedAt: string,
  maxPeriods = DEFAULT_MAX_PERIODS,
): CompanyFactRow[] {
  const root = asRecord(payload);
  const facts = asRecord(root?.facts);
  const usGaap = asRecord(facts?.["us-gaap"]);
  if (!usGaap) return [];

  const byPeriod = new Map<string, Partial<CompanyFactRow> & { period_end: string }>();
  for (const metric of Object.keys(METRIC_TAGS) as CompanyFactMetric[]) {
    pickMetricValue(usGaap, metric, byPeriod);
  }

  const rows: CompanyFactRow[] = [];
  for (const partial of byPeriod.values()) {
    const hasPl =
      partial.revenue != null ||
      partial.net_income != null ||
      partial.diluted_eps != null ||
      partial.share_based_compensation != null;
    if (!hasPl) continue;
    rows.push({
      ticker,
      security_id: securityIdForTicker(ticker),
      cik,
      period_end: partial.period_end,
      period_type: partial.period_type || "UNK",
      fiscal_year: partial.fiscal_year ?? null,
      form: partial.form ?? null,
      filed_at: partial.filed_at ?? null,
      frame: partial.frame ?? null,
      revenue: partial.revenue ?? null,
      net_income: partial.net_income ?? null,
      operating_cash_flow: partial.operating_cash_flow ?? null,
      diluted_eps: partial.diluted_eps ?? null,
      share_based_compensation: partial.share_based_compensation ?? null,
      long_term_debt: partial.long_term_debt ?? null,
      long_term_debt_current: partial.long_term_debt_current ?? null,
      cash: partial.cash ?? null,
      operating_lease_liability: partial.operating_lease_liability ?? null,
      finance_lease_liability: partial.finance_lease_liability ?? null,
      interest_expense: partial.interest_expense ?? null,
      source: COMPANY_FACTS_SOURCE,
      run_id: runId,
      fetched_at: fetchedAt,
    });
  }

  rows.sort((a, b) => b.period_end.localeCompare(a.period_end));
  return rows.slice(0, Math.max(1, maxPeriods));
}

async function secGet(url: string, env: CompanyFactsEnv): Promise<unknown> {
  const retries = Math.floor(num(env.HTTP_RETRIES, HTTP_RETRIES_DEFAULT));
  const timeoutMs = Math.floor(num(env.REQUEST_TIMEOUT, REQUEST_TIMEOUT_SECONDS_DEFAULT) * 1000);
  const ua = env.SEC_USER_AGENT || DEFAULT_SEC_USER_AGENT;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": ua,
          accept: "application/json",
          "accept-encoding": "gzip, deflate",
        },
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      const code = response.status;
      const detail = await response.text();
      lastError = new Error(`SEC HTTP ${code}: ${detail.slice(0, 160)}`);
      if (code !== 408 && code !== 429 && code < 500) throw lastError;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(backoffSeconds(env, attempt) * 1000);
      else break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`SEC fetch failed after ${retries + 1} attempts: ${errMsg(lastError)}`);
}

async function requestJson(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  authToken: string,
  env: CompanyFactsEnv,
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

export async function publishCompanyFacts(
  ticker: string,
  env: CompanyFactsEnv = {},
  opts?: { cikMap?: Map<string, string> },
): Promise<CompanyFactsPublishResult> {
  const url = env.PIPELINE_COMPANY_FACTS_URL || "";
  if (!url) {
    throw new Error("company facts publish requires PIPELINE_COMPANY_FACTS_URL");
  }
  const runId = env.runId?.() ?? crypto.randomUUID();
  const fetchedAt = (env.now ? env.now() : new Date()).toISOString();
  const secEnv: SecEnv = {
    SEC_TICKERS_URL: env.SEC_TICKERS_URL || DEFAULT_SEC_TICKERS_URL,
    SEC_USER_AGENT: env.SEC_USER_AGENT,
    HTTP_RETRIES: env.HTTP_RETRIES,
    RETRY_BACKOFF_SECONDS: env.RETRY_BACKOFF_SECONDS,
    REQUEST_TIMEOUT: env.REQUEST_TIMEOUT,
    cikByTicker: env.cikByTicker,
  };
  const cikMap = opts?.cikMap ?? (await loadCikMap(secEnv));
  const cik = cikMap.get(ticker.trim().toUpperCase()) ?? null;
  if (!cik) {
    return { ticker, cik: null, row_count: 0, published: false, run_id: runId };
  }
  const template = env.SEC_COMPANY_FACTS_TEMPLATE || DEFAULT_COMPANY_FACTS_TEMPLATE;
  const factsUrl = template.replace("{cik}", padCik(cik));
  const payload = await secGet(factsUrl, env);
  const maxPeriods = Math.floor(num(env.COMPANY_FACTS_MAX_PERIODS, DEFAULT_MAX_PERIODS));
  const rows = parseCompanyFacts(payload, ticker, padCik(cik), runId, fetchedAt, maxPeriods);
  if (rows.length === 0) {
    return { ticker, cik: padCik(cik), row_count: 0, published: false, run_id: runId };
  }
  await requestJson(
    url,
    rows.map(project),
    `company_facts:${runId}:${ticker}`,
    env.PIPELINE_AUTH_TOKEN || "",
    env,
  );
  return {
    ticker,
    cik: padCik(cik),
    row_count: rows.length,
    published: true,
    run_id: runId,
  };
}
