/**
 * Earnings intelligence for the equities research page.
 *
 * Combines lake earnings calendar + reported EPS results + SEC companyfacts
 * (SBC, debt, NI, OCF) into quality flags and an optional AI summary. Cache
 * the summary on the D1 research payload (same pattern as Lobster commentary).
 */

import { generateText, type LanguageModel } from "ai";
import {
  getOrComputeResearch,
  writeResearchCache,
  RESEARCH_TTL_MS,
  type ResearchDeps,
  type ResearchEnv,
  type TickerResearch,
  type EarningsBrief,
} from "./research";

export type EarningsSummarySource = "llm" | "notes" | "insufficient";

export interface EarningsResultBrief {
  quarter_end: string;
  period_label: string | null;
  eps_actual: number | null;
  eps_estimate: number | null;
  eps_difference: number | null;
  /** Fraction (0.045 = 4.5%), matching Yahoo surprisePercent.raw */
  surprise_pct: number | null;
  currency: string | null;
}

export interface CompanyFactBrief {
  period_end: string;
  period_type: string;
  fiscal_year: number | null;
  form: string | null;
  filed_at: string | null;
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
}

export type QualityFlagSeverity = "info" | "watch" | "alert";

export interface EarningsQualityFlag {
  id: string;
  severity: QualityFlagSeverity;
  title: string;
  detail: string;
}

export interface EarningsQualityBrief {
  period_end: string | null;
  period_type: string | null;
  /** SBC / |net income| when both present. */
  sbc_pct_of_net_income: number | null;
  /** Net income + SBC (cash-ish view of earnings power). */
  sbc_adjusted_net_income: number | null;
  /** Long-term debt + current LT debt − cash. */
  net_debt: number | null;
  /** Operating + finance lease liabilities. */
  lease_liabilities: number | null;
  flags: EarningsQualityFlag[];
}

export interface EarningsReportRef {
  form_type: string;
  filed_at: string;
  edgar_url: string;
  description: string | null;
}

export interface TickerEarningsIntel {
  ticker: string;
  security_id: string;
  calendar: EarningsBrief[];
  results: EarningsResultBrief[];
  facts: CompanyFactBrief[];
  quality: EarningsQualityBrief;
  /** 8-K (or similar) used to ground the AI summary, when available. */
  report: EarningsReportRef | null;
  summary: string | null;
  summary_source: EarningsSummarySource | null;
  summary_computed_at: string | null;
  cache_hit: boolean;
}

export const EARNINGS_SUMMARY_SYSTEM = [
  "You are Lobster MP — a senior equity analyst writing a short earnings-quality brief.",
  "Ground every claim in the structured facts and any earnings-report excerpt provided. Do not invent numbers, guidance, or news.",
  "Use short Markdown paragraphs (1–2 sentences) separated by blank lines.",
  "Lead with the latest reported print (beat/miss) or the next calendar date if no results yet.",
  "When an 8-K / earnings-release excerpt is present, summarize the company narrative in 2–3 sentences,",
  "then reconcile it with the XBRL facts (especially stock-based compensation and debt).",
  "Call out earnings-quality tells when present: stock-based compensation vs net income,",
  "SBC-adjusted earnings, net debt vs cash, lease liabilities alongside reported debt,",
  "and operating cash flow vs GAAP net income.",
  "When companies present non-GAAP that excludes SBC, say so plainly — that is the hide.",
  "Close with one line on what an options trader should watch into the next print.",
  "No code fences, no tables, no headings (#), no emoji. No 'as an AI'.",
].join("\n");

/** Prefer 8-K current reports that look like earnings releases. */
export function pickEarningsReportFiling(
  filings: Array<{ form_type: string; description: string | null; edgar_url: string; filed_at: string }>,
): { form_type: string; description: string | null; edgar_url: string; filed_at: string } | null {
  const earningsish = /result|earning|financial|operating|item\s*2\.02|press/i;
  const eights = filings.filter((f) => /^8-K/i.test(f.form_type) && f.edgar_url);
  const scored = eights.find((f) => earningsish.test(f.description || ""));
  return scored || eights[0] || null;
}

/**
 * Fetch an EDGAR primary document and return a plain-text excerpt suitable for
 * an LLM prompt. Best-effort: network/HTML failures return null.
 */
export async function fetchEdgarReportExcerpt(
  edgarUrl: string,
  opts?: { maxChars?: number; fetchImpl?: typeof fetch; userAgent?: string },
): Promise<string | null> {
  const maxChars = opts?.maxChars ?? 8_000;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ua = opts?.userAgent || "LobsterMarketPricing/0.1 (research; contact: rob@lobster.mp)";
  try {
    const res = await fetchImpl(edgarUrl, {
      headers: {
        "user-agent": ua,
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    const text = htmlToPlainText(raw);
    if (!text || text.length < 80) return null;
    return text.slice(0, maxChars);
  } catch (e) {
    console.error("edgar report excerpt fetch failed", e);
    return null;
  }
}

/** Strip tags / scripts and collapse whitespace for prompt grounding. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtPctFrac(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/** Prefer the newest quarterly fact row that carries NI or SBC. */
export function pickQualityPeriod(facts: CompanyFactBrief[]): CompanyFactBrief | null {
  const quarterly = facts.filter((f) => /^Q[1-4]$/.test(f.period_type));
  const pool = quarterly.length ? quarterly : facts;
  return (
    pool.find(
      (f) =>
        f.net_income != null ||
        f.share_based_compensation != null ||
        f.revenue != null,
    ) ?? null
  );
}

export function buildEarningsQuality(facts: CompanyFactBrief[]): EarningsQualityBrief {
  const period = pickQualityPeriod(facts);
  if (!period) {
    return {
      period_end: null,
      period_type: null,
      sbc_pct_of_net_income: null,
      sbc_adjusted_net_income: null,
      net_debt: null,
      lease_liabilities: null,
      flags: [],
    };
  }

  const sbc = period.share_based_compensation;
  const ni = period.net_income;
  const sbcPct =
    sbc != null && ni != null && Math.abs(ni) > 0 ? sbc / Math.abs(ni) : null;
  const sbcAdj =
    sbc != null && ni != null ? ni + sbc : null;
  const ltd = (period.long_term_debt ?? 0) + (period.long_term_debt_current ?? 0);
  const hasDebt = period.long_term_debt != null || period.long_term_debt_current != null;
  const cash = period.cash;
  const netDebt =
    hasDebt && cash != null ? ltd - cash : hasDebt ? ltd : null;
  const leases =
    period.operating_lease_liability != null || period.finance_lease_liability != null
      ? (period.operating_lease_liability ?? 0) + (period.finance_lease_liability ?? 0)
      : null;

  const flags: EarningsQualityFlag[] = [];

  if (sbc != null && ni != null && sbc > Math.abs(ni)) {
    flags.push({
      id: "sbc_exceeds_ni",
      severity: "alert",
      title: "SBC exceeds GAAP net income",
      detail:
        `Share-based compensation ${fmtUsd(sbc)} is larger than |net income| ${fmtUsd(ni)} ` +
        `for ${period.period_end}. Non-GAAP that excludes SBC can flip the print.`,
    });
  } else if (sbcPct != null && sbcPct >= 0.15) {
    flags.push({
      id: "sbc_material",
      severity: "watch",
      title: "Material stock-based compensation",
      detail:
        `SBC is ${fmtPctFrac(sbcPct)} of |net income| (${fmtUsd(sbc)} vs ${fmtUsd(ni)}). ` +
        `Watch any “adjusted” EPS that adds SBC back.`,
    });
  } else if (sbc != null && sbc > 0) {
    flags.push({
      id: "sbc_present",
      severity: "info",
      title: "Stock-based compensation disclosed",
      detail: `SBC ${fmtUsd(sbc)} in the ${period.period_type} period ending ${period.period_end}.`,
    });
  }

  if (sbcAdj != null && ni != null && sbc != null && sbc > 0) {
    flags.push({
      id: "sbc_adjusted_ni",
      severity: "info",
      title: "SBC-adjusted net income",
      detail:
        `GAAP NI ${fmtUsd(ni)} + SBC ${fmtUsd(sbc)} ≈ ${fmtUsd(sbcAdj)} ` +
        `(cash-ish earnings power; still dilutive for shareholders).`,
    });
  }

  if (
    period.operating_cash_flow != null &&
    ni != null &&
    Math.abs(ni) > 0 &&
    period.operating_cash_flow < ni * 0.7 &&
    period.operating_cash_flow < ni
  ) {
    flags.push({
      id: "ocf_below_ni",
      severity: "watch",
      title: "Operating cash flow trails GAAP NI",
      detail:
        `OCF ${fmtUsd(period.operating_cash_flow)} vs NI ${fmtUsd(ni)} — ` +
        `earnings quality may be softer than the headline.`,
    });
  }

  if (leases != null && leases > 0 && hasDebt) {
    const leaseVsDebt = ltd > 0 ? leases / ltd : null;
    if (leaseVsDebt != null && leaseVsDebt >= 0.15) {
      flags.push({
        id: "lease_debt",
        severity: "watch",
        title: "Lease liabilities are material vs debt",
        detail:
          `Leases ${fmtUsd(leases)} vs long-term debt ${fmtUsd(ltd)} ` +
          `(${fmtPctFrac(leaseVsDebt)}). Headline D/E can understate leverage.`,
      });
    }
  }

  if (netDebt != null) {
    flags.push({
      id: "net_debt",
      severity: netDebt > 0 ? "info" : "info",
      title: netDebt > 0 ? "Net debt position" : "Net cash position",
      detail:
        `Long-term debt ${fmtUsd(ltd)} − cash ${fmtUsd(cash)} = ${fmtUsd(netDebt)}.`,
    });
  }

  return {
    period_end: period.period_end,
    period_type: period.period_type,
    sbc_pct_of_net_income: sbcPct,
    sbc_adjusted_net_income: sbcAdj,
    net_debt: netDebt,
    lease_liabilities: leases,
    flags,
  };
}

/** When Yahoo history is empty, surface diluted EPS from SEC periods as actuals. */
export function resultsFromCompanyFacts(facts: CompanyFactBrief[]): EarningsResultBrief[] {
  const out: EarningsResultBrief[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.diluted_eps == null || !Number.isFinite(f.diluted_eps)) continue;
    if (!/^Q[1-4]$|^FY$/.test(f.period_type)) continue;
    if (seen.has(f.period_end)) continue;
    seen.add(f.period_end);
    out.push({
      quarter_end: f.period_end,
      period_label: f.period_type,
      eps_actual: f.diluted_eps,
      eps_estimate: null,
      eps_difference: null,
      surprise_pct: null,
      currency: "USD",
    });
  }
  return out;
}

export function hasEnoughDataForEarningsSummary(
  results: EarningsResultBrief[],
  facts: CompanyFactBrief[],
  calendar: EarningsBrief[],
  hasReport = false,
): boolean {
  return results.length > 0 || facts.length > 0 || calendar.length > 0 || hasReport;
}

export function synthesizeEarningsSummary(
  ticker: string,
  results: EarningsResultBrief[],
  facts: CompanyFactBrief[],
  calendar: EarningsBrief[],
  quality: EarningsQualityBrief,
): string {
  const parts: string[] = [];
  const latest = results[0];
  if (latest) {
    const surprise =
      latest.surprise_pct != null
        ? ` (${latest.surprise_pct >= 0 ? "+" : ""}${fmtPctFrac(latest.surprise_pct)} surprise)`
        : "";
    parts.push(
      `${ticker} printed EPS ${latest.eps_actual ?? "—"} vs ${latest.eps_estimate ?? "—"} est` +
        ` for the quarter ending ${latest.quarter_end}${surprise}.`,
    );
  } else if (calendar[0]) {
    const e = calendar[0];
    parts.push(
      `Next/recent calendar print for ${ticker}: ${e.earnings_date}` +
        `${e.time ? ` ${e.time}` : ""}` +
        `${e.eps_forecast != null ? ` · EPS est ${e.eps_forecast}` : ""}.`,
    );
  } else {
    parts.push(`No reported EPS history or calendar row in the lake yet for ${ticker}.`);
  }

  if (quality.flags.length) {
    const top = quality.flags.filter((f) => f.severity !== "info").slice(0, 2);
    const use = top.length ? top : quality.flags.slice(0, 2);
    for (const f of use) {
      parts.push(`**${f.title}.** ${f.detail}`);
    }
  } else if (facts[0]) {
    parts.push(
      `Latest SEC period ${facts[0].period_end} (${facts[0].period_type}): ` +
        `revenue ${fmtUsd(facts[0].revenue)}, NI ${fmtUsd(facts[0].net_income)}, ` +
        `SBC ${fmtUsd(facts[0].share_based_compensation)}.`,
    );
  }

  parts.push(
    "Into the next print, prefer defined-risk structures and treat non-GAAP that excludes SBC as a dilution tell.",
  );
  return parts.join("\n\n");
}

function compactEarningsPrompt(
  ticker: string,
  name: string | null,
  results: EarningsResultBrief[],
  facts: CompanyFactBrief[],
  calendar: EarningsBrief[],
  quality: EarningsQualityBrief,
  reportExcerpt?: string | null,
  reportMeta?: { form_type: string; filed_at: string; edgar_url: string } | null,
): string {
  const lines = [
    `${ticker}${name ? ` — ${name}` : ""}`,
    ...results.slice(0, 4).map(
      (r) =>
        `Result ${r.quarter_end}: EPS act ${r.eps_actual} est ${r.eps_estimate} ` +
        `diff ${r.eps_difference} surprise ${r.surprise_pct}`,
    ),
    ...facts.slice(0, 4).map(
      (f) =>
        `Facts ${f.period_end} ${f.period_type}: rev ${f.revenue} NI ${f.net_income} ` +
        `OCF ${f.operating_cash_flow} SBC ${f.share_based_compensation} ` +
        `LT debt ${f.long_term_debt} cash ${f.cash} leases ` +
        `${(f.operating_lease_liability ?? 0) + (f.finance_lease_liability ?? 0)}`,
    ),
    ...calendar.slice(0, 3).map(
      (e) =>
        `Calendar ${e.earnings_date}${e.time ? ` ${e.time}` : ""}` +
        `${e.fiscal_q ? ` ${e.fiscal_q}` : ""} est ${e.eps_forecast}`,
    ),
    ...quality.flags.map((f) => `Flag [${f.severity}] ${f.title}: ${f.detail}`),
  ];
  if (reportMeta && reportExcerpt) {
    lines.push(
      `Report ${reportMeta.form_type} filed ${reportMeta.filed_at}: ${reportMeta.edgar_url}`,
      `Report excerpt: ${reportExcerpt}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

async function generateEarningsSummary(
  ticker: string,
  name: string | null,
  results: EarningsResultBrief[],
  facts: CompanyFactBrief[],
  calendar: EarningsBrief[],
  quality: EarningsQualityBrief,
  model: LanguageModel,
  reportExcerpt?: string | null,
  reportMeta?: { form_type: string; filed_at: string; edgar_url: string } | null,
): Promise<string | null> {
  try {
    const { text } = await generateText({
      model,
      system: EARNINGS_SUMMARY_SYSTEM,
      prompt: compactEarningsPrompt(
        ticker,
        name,
        results,
        facts,
        calendar,
        quality,
        reportExcerpt,
        reportMeta,
      ),
      maxOutputTokens: 650,
    });
    const trimmed = text?.trim() ?? "";
    return trimmed || null;
  } catch (e) {
    console.error("earnings summary LLM failed", e);
    return null;
  }
}

export interface EarningsIntelDeps extends ResearchDeps {
  loadEarningsResults: (ticker: string) => Promise<EarningsResultBrief[]>;
  loadCompanyFacts: (ticker: string) => Promise<CompanyFactBrief[]>;
  /** Optional SEC filings (for 8-K earnings-release grounding). */
  loadFilings?: (
    ticker: string,
  ) => Promise<Array<{ form_type: string; description: string | null; edgar_url: string; filed_at: string }>>;
  createModel?: () => LanguageModel | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function researchSummaryFields(r: TickerResearch): {
  summary: string | null;
  source: EarningsSummarySource | null;
  computed_at: string | null;
} {
  const extended = r as TickerResearch & {
    earnings_summary?: string | null;
    earnings_summary_source?: EarningsSummarySource | null;
    earnings_summary_computed_at?: string | null;
  };
  return {
    summary: extended.earnings_summary?.trim() || null,
    source: extended.earnings_summary_source ?? null,
    computed_at: extended.earnings_summary_computed_at ?? null,
  };
}

async function persistEarningsSummary(
  env: ResearchEnv,
  research: TickerResearch,
  summary: string,
  source: EarningsSummarySource,
  now: number,
): Promise<void> {
  const computedAt = new Date(now).toISOString();
  const next = {
    ...research,
    earnings_summary: summary,
    earnings_summary_source: source,
    earnings_summary_computed_at: computedAt,
    cache_hit: false,
  } as TickerResearch;
  const expiresAt = Date.parse(research.expires_at);
  const ttl = Number.isFinite(expiresAt) && expiresAt > now
    ? expiresAt
    : now + RESEARCH_TTL_MS;
  try {
    await writeResearchCache(env.SCHEMA_DB, next, ttl);
  } catch (e) {
    console.error("earnings summary cache write failed", e);
  }
}

/**
 * Build earnings intel for a ticker: lake results + facts + quality flags +
 * optional 8-K report excerpt + cached AI/notes summary.
 */
export async function getOrComputeEarningsIntel(
  env: ResearchEnv,
  rawTicker: string,
  deps: EarningsIntelDeps,
  opts?: { force?: boolean },
): Promise<TickerEarningsIntel> {
  const now = deps.now?.() ?? Date.now();
  const research = await getOrComputeResearch(env, rawTicker, deps, { force: false });
  const ticker = research.identity.ticker;
  const [resultsRaw, facts, filings] = await Promise.all([
    deps.loadEarningsResults(ticker),
    deps.loadCompanyFacts(ticker),
    deps.loadFilings ? deps.loadFilings(ticker) : Promise.resolve([]),
  ]);
  const results = resultsRaw.length ? resultsRaw : resultsFromCompanyFacts(facts);
  const calendar = research.earnings ?? [];
  const quality = buildEarningsQuality(facts);
  const reportPick = pickEarningsReportFiling(filings);
  const report: EarningsReportRef | null = reportPick
    ? {
        form_type: reportPick.form_type,
        filed_at: reportPick.filed_at,
        edgar_url: reportPick.edgar_url,
        description: reportPick.description,
      }
    : null;
  const cached = researchSummaryFields(research);
  const enough = hasEnoughDataForEarningsSummary(results, facts, calendar, Boolean(report));

  if (!enough) {
    const summary = `Not enough earnings data yet in the lake for ${ticker}.`;
    return {
      ticker,
      security_id: research.identity.security_id,
      calendar,
      results,
      facts,
      quality,
      report,
      summary,
      summary_source: "insufficient",
      summary_computed_at: new Date(now).toISOString(),
      cache_hit: false,
    };
  }

  if (!opts?.force && cached.summary && cached.source && cached.source !== "insufficient") {
    return {
      ticker,
      security_id: research.identity.security_id,
      calendar,
      results,
      facts,
      quality,
      report,
      summary: cached.summary,
      summary_source: cached.source,
      summary_computed_at: cached.computed_at,
      cache_hit: true,
    };
  }

  let reportExcerpt: string | null = null;
  if (report) {
    reportExcerpt = await fetchEdgarReportExcerpt(report.edgar_url, {
      fetchImpl: deps.fetchImpl,
    });
  }

  let summary: string | null = null;
  let source: EarningsSummarySource = "notes";
  const model = deps.createModel?.() ?? null;
  if (model) {
    summary = await generateEarningsSummary(
      ticker,
      research.identity.name,
      results,
      facts,
      calendar,
      quality,
      model,
      reportExcerpt,
      report,
    );
    if (summary) source = "llm";
  }
  if (!summary) {
    summary = synthesizeEarningsSummary(ticker, results, facts, calendar, quality);
    if (report) {
      summary += `\n\nGrounded filing: ${report.form_type} (${report.filed_at}) — ${report.edgar_url}`;
    }
    source = "notes";
  }

  const computedAt = new Date(now).toISOString();
  await persistEarningsSummary(env, research, summary, source, now);

  return {
    ticker,
    security_id: research.identity.security_id,
    calendar,
    results,
    facts,
    quality,
    report,
    summary,
    summary_source: source,
    summary_computed_at: computedAt,
    cache_hit: false,
  };
}
