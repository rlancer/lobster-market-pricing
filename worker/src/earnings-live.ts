/**
 * Live Yahoo + SEC fetches for earnings intel when lake tables are empty
 * (pipelines not yet provisioned / quota blocked). Same sources as the loader
 * jobs; results are cached on the D1 research payload via the earnings-intel
 * summary path. Prefer lake rows when present.
 */

import type { CompanyFactBrief, EarningsResultBrief } from "./earnings-intel";

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SEC_UA = "LobsterMarketPricing/0.1 (research; contact: rob@lobster.mp)";
const COOKIE_URL = "https://fc.yahoo.com";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const QUOTE_SUMMARY =
  "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}" +
  "?modules=earningsHistory&crumb={crumb}";
const SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json";
const COMPANY_FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function yahooSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\./g, "-");
}

function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function quarterEndFromYahoo(value: unknown): string | null {
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

function cookieFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    const parts = headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  // Do NOT split on commas — Expires=Mon, 23 Aug … embeds commas.
  const one = headers.get("set-cookie");
  return one ? one.split(";")[0].trim() : "";
}

async function openYahooSession(fetchImpl: typeof fetch): Promise<{ cookie: string; crumb: string }> {
  const cookieRes = await fetchImpl(COOKIE_URL, {
    headers: { "user-agent": YAHOO_UA },
    redirect: "manual",
  });
  const cookie = cookieFrom(cookieRes);
  if (!cookie) throw new Error("yahoo cookie missing");
  const crumbRes = await fetchImpl(CRUMB_URL, {
    headers: { "user-agent": YAHOO_UA, cookie, accept: "text/plain" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!crumbRes.ok) throw new Error(`yahoo crumb HTTP ${crumbRes.status}`);
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.startsWith("{") || crumb.includes(" ")) {
    throw new Error(`yahoo crumb invalid: ${crumb.slice(0, 40)}`);
  }
  return { cookie, crumb };
}

/** Parse Yahoo earningsHistory payload into result rows. */
export function parseLiveEarningsHistory(payload: unknown): EarningsResultBrief[] {
  const root = asRecord(payload);
  const qs = asRecord(root?.quoteSummary);
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) return [];
  const history = asRecord(result.earningsHistory);
  const rows = Array.isArray(history?.history) ? history.history : [];
  const out: EarningsResultBrief[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const rec = asRecord(item);
    if (!rec) continue;
    const quarterEnd = quarterEndFromYahoo(rec.quarter);
    if (!quarterEnd || seen.has(quarterEnd)) continue;
    seen.add(quarterEnd);
    out.push({
      quarter_end: quarterEnd,
      period_label: typeof rec.period === "string" ? rec.period.trim() : null,
      eps_actual: rawNum(rec.epsActual),
      eps_estimate: rawNum(rec.epsEstimate),
      eps_difference: rawNum(rec.epsDifference),
      surprise_pct: rawNum(rec.surprisePercent),
      currency: typeof rec.currency === "string" ? rec.currency : null,
    });
  }
  return out;
}

export async function fetchLiveEarningsResults(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EarningsResultBrief[]> {
  try {
    const session = await openYahooSession(fetchImpl);
    const url = QUOTE_SUMMARY
      .replace("{symbol}", encodeURIComponent(yahooSymbol(ticker)))
      .replace("{crumb}", encodeURIComponent(session.crumb));
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": YAHOO_UA,
        cookie: session.cookie,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`live earnings results HTTP ${res.status} for ${ticker}`);
      return [];
    }
    const rows = parseLiveEarningsHistory(await res.json());
    if (!rows.length) console.error(`live earnings results empty parse for ${ticker}`);
    return rows;
  } catch (e) {
    console.error("live earnings results fetch failed", e);
    return [];
  }
}

type Metric =
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

const METRIC_TAGS: Record<Metric, readonly string[]> = {
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

const BALANCE = new Set<Metric>([
  "long_term_debt",
  "long_term_debt_current",
  "cash",
  "operating_lease_liability",
  "finance_lease_liability",
]);

function periodTypeFromFp(fp: string | null | undefined, frame?: string | null): string {
  const f = (fp || "").trim().toUpperCase();
  if (f === "FY" || f === "Q1" || f === "Q2" || f === "Q3" || f === "Q4") return f;
  const fr = (frame || "").trim().toUpperCase();
  if (/Q1I?$/.test(fr)) return "Q1";
  if (/Q2I?$/.test(fr)) return "Q2";
  if (/Q3I?$/.test(fr)) return "Q3";
  if (/Q4I?$/.test(fr)) return "Q4";
  if (/^CY\d{4}I?$/.test(fr)) return "FY";
  return f || "UNK";
}

function collectFramed(
  tagPayload: unknown,
  metric: Metric,
): Array<{ end: string; val: number; fy: number | null; fp: string | null; form: string | null; filed: string | null; frame: string }> {
  const rec = asRecord(tagPayload);
  const units = asRecord(rec?.units);
  if (!units) return [];
  const out: Array<{ end: string; val: number; fy: number | null; fp: string | null; form: string | null; filed: string | null; frame: string }> = [];
  for (const unitKey of Object.keys(units)) {
    const arr = units[unitKey];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const e = asRecord(raw);
      if (!e) continue;
      const frame = typeof e.frame === "string" ? e.frame.trim() : "";
      if (!frame) continue;
      const isInstant = /I$/.test(frame);
      if (BALANCE.has(metric) ? !isInstant : isInstant) continue;
      const end = typeof e.end === "string" ? e.end.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}/.test(end)) continue;
      const val = typeof e.val === "number" && Number.isFinite(e.val) ? e.val : null;
      if (val == null) continue;
      const form = typeof e.form === "string" ? e.form.trim().toUpperCase() : null;
      if (form && !/^10-[KQ]/.test(form)) continue;
      out.push({
        end: end.slice(0, 10),
        val,
        fy: typeof e.fy === "number" ? e.fy : null,
        fp: typeof e.fp === "string" ? e.fp.trim().toUpperCase() : null,
        form,
        filed: typeof e.filed === "string" ? e.filed.trim().slice(0, 10) : null,
        frame,
      });
    }
  }
  out.sort((a, b) => b.end.localeCompare(a.end) || (b.filed || "").localeCompare(a.filed || ""));
  return out;
}

/** Parse SEC companyfacts JSON into period brief rows. */
export function parseLiveCompanyFacts(payload: unknown, maxPeriods = 8): CompanyFactBrief[] {
  const root = asRecord(payload);
  const facts = asRecord(root?.facts);
  const usGaap = asRecord(facts?.["us-gaap"]);
  if (!usGaap) return [];

  type PartialRow = Partial<CompanyFactBrief> & { period_end: string; period_type: string };
  const byPeriod = new Map<string, PartialRow>();

  for (const metric of Object.keys(METRIC_TAGS) as Metric[]) {
    for (const tag of METRIC_TAGS[metric]) {
      const points = collectFramed(usGaap[tag], metric);
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
          };
          byPeriod.set(key, row);
        }
        if ((row as Record<string, unknown>)[metric] == null) {
          (row as Record<string, unknown>)[metric] = p.val;
        }
      }
      break;
    }
  }

  const rows: CompanyFactBrief[] = [];
  for (const partial of byPeriod.values()) {
    const hasPl =
      partial.revenue != null ||
      partial.net_income != null ||
      partial.diluted_eps != null ||
      partial.share_based_compensation != null;
    if (!hasPl) continue;
    rows.push({
      period_end: partial.period_end,
      period_type: partial.period_type,
      fiscal_year: partial.fiscal_year ?? null,
      form: partial.form ?? null,
      filed_at: partial.filed_at ?? null,
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
    });
  }
  rows.sort((a, b) => b.period_end.localeCompare(a.period_end));
  return rows.slice(0, maxPeriods);
}

let cikCache: Map<string, string> | null = null;

async function loadCikMap(fetchImpl: typeof fetch): Promise<Map<string, string>> {
  if (cikCache) return cikCache;
  const res = await fetchImpl(SEC_TICKERS, {
    headers: { "user-agent": SEC_UA, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`SEC tickers HTTP ${res.status}`);
  const payload = await res.json();
  const map = new Map<string, string>();
  for (const row of Object.values(asRecord(payload) || {})) {
    const rec = asRecord(row);
    const ticker = String(rec?.ticker || "").trim().toUpperCase();
    const cik = rec?.cik_str ?? rec?.cik;
    if (ticker && (typeof cik === "string" || typeof cik === "number")) {
      map.set(ticker, padCik(cik));
    }
  }
  cikCache = map;
  return map;
}

export async function fetchLiveCompanyFacts(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CompanyFactBrief[]> {
  try {
    const map = await loadCikMap(fetchImpl);
    const cik = map.get(ticker.trim().toUpperCase());
    if (!cik) return [];
    const url = COMPANY_FACTS.replace("{cik}", cik);
    const res = await fetchImpl(url, {
      headers: {
        "user-agent": SEC_UA,
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return [];
    return parseLiveCompanyFacts(await res.json());
  } catch (e) {
    console.error("live company facts fetch failed", e);
    return [];
  }
}
