/**
 * Per-ticker research brief: recent price/volume moves, technical posture
 * (consolidation / accumulation), earnings, news, and best-effort fundamentals
 * (market cap, PE, debt) from Yahoo quoteSummary. Cached in D1 so the chat
 * widget and /research/:ticker route share one compute path.
 */

import type { TickerIdentity } from "./figi";
import { resolveTickerIdentity, type LakeLookup } from "./figi";
import { linkChatTicker } from "./chat-tickers";
import { normalizeTicker } from "./symbology";

export const RESEARCH_TTL_MS = 60 * 60 * 1000; // 1 hour
export const RESEARCH_NEWS_LIMIT = 8;
export const RESEARCH_EARNINGS_LIMIT = 6;
export const RESEARCH_OHLC_LIMIT = 90;

export interface OhlcBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface RealizedVolBrief {
  as_of_date: string;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
}

export interface EarningsBrief {
  earnings_date: string;
  time: string | null;
  fiscal_q: string | null;
  eps_forecast: number | null;
  last_year_eps: number | null;
  name: string | null;
}

export interface NewsBrief {
  title: string;
  link: string;
}

export interface FundamentalsBrief {
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
  source: string | null;
}

export interface TechnicalBrief {
  trend: "up" | "down" | "sideways" | "unknown";
  consolidation: boolean;
  consolidation_range_pct: number | null;
  accumulation: "accumulating" | "distributing" | "neutral" | "unknown";
  notes: string[];
}

export interface PriceMoveBrief {
  spot: number | null;
  change_1d_pct: number | null;
  change_5d_pct: number | null;
  change_21d_pct: number | null;
  change_63d_pct: number | null;
  high_63d: number | null;
  low_63d: number | null;
  volume_latest: number | null;
  volume_avg_20d: number | null;
  volume_relative_20d: number | null;
}

export interface TickerResearch {
  identity: TickerIdentity;
  price: PriceMoveBrief;
  technicals: TechnicalBrief;
  realized_vol: RealizedVolBrief | null;
  fundamentals: FundamentalsBrief;
  earnings: EarningsBrief[];
  news: NewsBrief[];
  etf: {
    name: string | null;
    family: string | null;
    category: string | null;
    net_assets: number | null;
    expense_ratio: number | null;
  } | null;
  computed_at: string;
  expires_at: string;
  cache_hit: boolean;
}

export interface ResearchDeps {
  lakeLookup?: LakeLookup;
  loadOhlc: (ticker: string) => Promise<OhlcBar[]>;
  loadRealizedVol: (ticker: string) => Promise<RealizedVolBrief | null>;
  loadEarnings: (ticker: string) => Promise<EarningsBrief[]>;
  loadNews: (ticker: string, limit: number) => Promise<{ items: NewsBrief[]; error?: string }>;
  loadEtfProfile?: (ticker: string) => Promise<TickerResearch["etf"]>;
  loadFundamentals?: (ticker: string) => Promise<FundamentalsBrief>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

function closes(bars: OhlcBar[]): number[] {
  return bars.map((b) => b.close).filter((v): v is number => v != null && Number.isFinite(v));
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Pure technical / price-move analysis over ascending OHLC bars. */
export function analyzePriceAction(barsAsc: OhlcBar[]): { price: PriceMoveBrief; technicals: TechnicalBrief } {
  const notes: string[] = [];
  const n = barsAsc.length;
  const last = n ? barsAsc[n - 1] : null;
  const spot = last?.close ?? null;

  const closeAt = (offset: number): number | null => {
    const idx = n - 1 - offset;
    if (idx < 0) return null;
    return barsAsc[idx]?.close ?? null;
  };

  const price: PriceMoveBrief = {
    spot,
    change_1d_pct: pctChange(closeAt(1), spot),
    change_5d_pct: pctChange(closeAt(5), spot),
    change_21d_pct: pctChange(closeAt(21), spot),
    change_63d_pct: pctChange(closeAt(63), spot),
    high_63d: null,
    low_63d: null,
    volume_latest: last?.volume ?? null,
    volume_avg_20d: null,
    volume_relative_20d: null,
  };

  const window63 = barsAsc.slice(Math.max(0, n - 63));
  const highs = window63.map((b) => b.high).filter((v): v is number => v != null);
  const lows = window63.map((b) => b.low).filter((v): v is number => v != null);
  if (highs.length) price.high_63d = Math.max(...highs);
  if (lows.length) price.low_63d = Math.min(...lows);

  const vol20 = barsAsc.slice(Math.max(0, n - 20)).map((b) => b.volume).filter((v): v is number => v != null && v > 0);
  price.volume_avg_20d = mean(vol20);
  if (price.volume_latest != null && price.volume_avg_20d != null && price.volume_avg_20d > 0) {
    price.volume_relative_20d = price.volume_latest / price.volume_avg_20d;
  }

  // Consolidation: 20-session range as % of mid.
  const window20 = barsAsc.slice(Math.max(0, n - 20));
  const wHighs = window20.map((b) => b.high).filter((v): v is number => v != null);
  const wLows = window20.map((b) => b.low).filter((v): v is number => v != null);
  let consolidation = false;
  let consolidationRangePct: number | null = null;
  if (wHighs.length && wLows.length) {
    const hi = Math.max(...wHighs);
    const lo = Math.min(...wLows);
    const mid = (hi + lo) / 2;
    if (mid > 0) {
      consolidationRangePct = ((hi - lo) / mid) * 100;
      consolidation = consolidationRangePct <= 8;
      if (consolidation) notes.push(`20-session range is tight (${consolidationRangePct.toFixed(1)}% of mid) — consolidation.`);
    }
  }

  // Accumulation / distribution via signed volume (OBV-style slope over 20 sessions).
  let accumulation: TechnicalBrief["accumulation"] = "unknown";
  if (n >= 10) {
    const slice = barsAsc.slice(Math.max(0, n - 21));
    let signed = 0;
    for (let i = 1; i < slice.length; i++) {
      const prev = slice[i - 1].close;
      const cur = slice[i].close;
      const vol = slice[i].volume;
      if (prev == null || cur == null || vol == null) continue;
      signed += cur > prev ? vol : cur < prev ? -vol : 0;
    }
    const avgVol = price.volume_avg_20d ?? 1;
    const score = signed / (avgVol * 20);
    if (score > 0.15) {
      accumulation = "accumulating";
      notes.push("Volume leans into up days over the last ~20 sessions (accumulation).");
    } else if (score < -0.15) {
      accumulation = "distributing";
      notes.push("Volume leans into down days over the last ~20 sessions (distribution).");
    } else {
      accumulation = "neutral";
    }
  }

  // Trend from 21d return + SMA20 vs SMA50 when enough history.
  let trend: TechnicalBrief["trend"] = "unknown";
  const c = closes(barsAsc);
  if (price.change_21d_pct != null) {
    if (price.change_21d_pct >= 5) trend = "up";
    else if (price.change_21d_pct <= -5) trend = "down";
    else trend = "sideways";
  }
  if (c.length >= 50) {
    const sma20 = mean(c.slice(-20));
    const sma50 = mean(c.slice(-50));
    if (sma20 != null && sma50 != null) {
      if (sma20 > sma50 * 1.01 && trend !== "down") {
        trend = "up";
        notes.push("SMA20 above SMA50 — intermediate uptrend bias.");
      } else if (sma20 < sma50 * 0.99 && trend !== "up") {
        trend = "down";
        notes.push("SMA20 below SMA50 — intermediate downtrend bias.");
      } else if (trend === "unknown") {
        trend = "sideways";
      }
    }
  }

  if (price.volume_relative_20d != null && price.volume_relative_20d >= 1.5) {
    notes.push(`Latest volume is ${(price.volume_relative_20d * 100).toFixed(0)}% of the 20-day average.`);
  }
  if (price.change_5d_pct != null && Math.abs(price.change_5d_pct) >= 5) {
    notes.push(`5-day move ${price.change_5d_pct >= 0 ? "+" : ""}${price.change_5d_pct.toFixed(1)}%.`);
  }
  if (!notes.length) notes.push("No strong consolidation or volume skew in the recent window.");

  return {
    price,
    technicals: {
      trend,
      consolidation,
      consolidation_range_pct: consolidationRangePct,
      accumulation,
      notes,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function yahooRaw(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.raw;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

const YAHOO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Best-effort Yahoo quoteSummary fundamentals (market cap, PE, debt). */
export async function fetchYahooFundamentals(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FundamentalsBrief> {
  const empty: FundamentalsBrief = {
    market_cap: null,
    enterprise_value: null,
    trailing_pe: null,
    forward_pe: null,
    peg_ratio: null,
    price_to_book: null,
    total_debt: null,
    debt_to_equity: null,
    profit_margins: null,
    revenue_growth: null,
    source: null,
  };
  try {
    // Crumb handshake (same pattern as loader ETF path).
    const cookieRes = await fetchImpl("https://fc.yahoo.com", {
      headers: { "user-agent": YAHOO_UA },
      redirect: "manual",
    });
    const headers = cookieRes.headers as Headers & { getSetCookie?: () => string[] };
    const cookie = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie().map((c) => c.split(";")[0]).filter(Boolean).join("; ")
      : (cookieRes.headers.get("set-cookie")?.split(";")[0] ?? "");
    const crumbRes = await fetchImpl("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "user-agent": YAHOO_UA, ...(cookie ? { cookie } : {}) },
    });
    if (!crumbRes.ok) return empty;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.includes("<")) return empty;

    const yahooTicker = ticker.replace(/\./g, "-");
    const url =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}` +
      `?modules=summaryDetail,defaultKeyStatistics,financialData&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetchImpl(url, {
      headers: { "user-agent": YAHOO_UA, ...(cookie ? { cookie } : {}) },
    });
    if (!res.ok) return empty;
    const payload = await res.json();
    const qs = asRecord(asRecord(payload)?.quoteSummary);
    const results = qs?.result;
    const first = Array.isArray(results) ? asRecord(results[0]) : null;
    if (!first) return empty;
    const summary = asRecord(first.summaryDetail);
    const stats = asRecord(first.defaultKeyStatistics);
    const financial = asRecord(first.financialData);
    return {
      market_cap: yahooRaw(summary?.marketCap),
      enterprise_value: yahooRaw(stats?.enterpriseValue),
      trailing_pe: yahooRaw(summary?.trailingPE) ?? yahooRaw(stats?.trailingPE),
      forward_pe: yahooRaw(summary?.forwardPE) ?? yahooRaw(stats?.forwardPE),
      peg_ratio: yahooRaw(stats?.pegRatio),
      price_to_book: yahooRaw(stats?.priceToBook),
      total_debt: yahooRaw(financial?.totalDebt),
      debt_to_equity: yahooRaw(financial?.debtToEquity),
      profit_margins: yahooRaw(financial?.profitMargins),
      revenue_growth: yahooRaw(financial?.revenueGrowth),
      source: "yahoo",
    };
  } catch (e) {
    console.error("yahoo fundamentals failed", e);
    return empty;
  }
}

export async function readResearchCache(
  db: D1Database,
  securityId: string,
  now = Date.now(),
): Promise<TickerResearch | null> {
  const row = await db.prepare(
    `SELECT payload, expires_at FROM ticker_research WHERE security_id = ?1`,
  ).bind(securityId).first<{ payload: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  try {
    const parsed = JSON.parse(row.payload) as TickerResearch;
    return { ...parsed, cache_hit: true };
  } catch {
    return null;
  }
}

export async function writeResearchCache(
  db: D1Database,
  research: TickerResearch,
  expiresAt: number,
): Promise<void> {
  const stored = { ...research, cache_hit: false };
  await db.prepare(
    `INSERT INTO ticker_research (security_id, ticker, payload, computed_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(security_id) DO UPDATE SET
       ticker = excluded.ticker,
       payload = excluded.payload,
       computed_at = excluded.computed_at,
       expires_at = excluded.expires_at`,
  ).bind(
    research.identity.security_id,
    research.identity.ticker,
    JSON.stringify(stored),
    Date.parse(research.computed_at) || Date.now(),
    expiresAt,
  ).run();
}

export interface ResearchEnv {
  SCHEMA_DB: D1Database;
  OPEN_FIGI?: string;
}

/**
 * Resolve identity (OpenFIGI), compose research, cache in D1, optionally link chat.
 */
export async function getOrComputeResearch(
  env: ResearchEnv,
  rawTicker: string,
  deps: ResearchDeps,
  opts?: { force?: boolean; chatId?: string },
): Promise<TickerResearch> {
  const now = deps.now?.() ?? Date.now();
  const identity = await resolveTickerIdentity(env, rawTicker, {
    lakeLookup: deps.lakeLookup,
    fetchImpl: deps.fetchImpl,
    now,
  });

  if (opts?.chatId) {
    try {
      await linkChatTicker(env.SCHEMA_DB, opts.chatId, identity, now);
    } catch (e) {
      console.error("chat ticker link failed", e);
    }
  }

  if (!opts?.force) {
    const cached = await readResearchCache(env.SCHEMA_DB, identity.security_id, now).catch(() => null);
    if (cached) {
      // Refresh identity fields from latest resolve while keeping cached analysis.
      return { ...cached, identity, cache_hit: true };
    }
  }

  const ticker = identity.ticker;
  const [ohlc, realizedVol, earnings, newsResult, etf, fundamentals] = await Promise.all([
    deps.loadOhlc(ticker).catch(() => [] as OhlcBar[]),
    deps.loadRealizedVol(ticker).catch(() => null),
    deps.loadEarnings(ticker).catch(() => [] as EarningsBrief[]),
    deps.loadNews(ticker, RESEARCH_NEWS_LIMIT).catch(() => ({ items: [] as NewsBrief[], error: "news failed" })),
    deps.loadEtfProfile ? deps.loadEtfProfile(ticker).catch(() => null) : Promise.resolve(null),
    deps.loadFundamentals
      ? deps.loadFundamentals(ticker).catch(() => emptyFundamentals())
      : fetchYahooFundamentals(ticker, deps.fetchImpl).catch(() => emptyFundamentals()),
  ]);

  const { price, technicals } = analyzePriceAction(ohlc);
  const computedAt = new Date(now).toISOString();
  const expiresAt = now + RESEARCH_TTL_MS;
  const research: TickerResearch = {
    identity,
    price,
    technicals,
    realized_vol: realizedVol,
    fundamentals,
    earnings: earnings.slice(0, RESEARCH_EARNINGS_LIMIT),
    news: newsResult.items.slice(0, RESEARCH_NEWS_LIMIT),
    etf,
    computed_at: computedAt,
    expires_at: new Date(expiresAt).toISOString(),
    cache_hit: false,
  };

  try {
    await writeResearchCache(env.SCHEMA_DB, research, expiresAt);
  } catch (e) {
    console.error("research cache write failed", e);
  }

  return research;
}

function emptyFundamentals(): FundamentalsBrief {
  return {
    market_cap: null,
    enterprise_value: null,
    trailing_pe: null,
    forward_pe: null,
    peg_ratio: null,
    price_to_book: null,
    total_debt: null,
    debt_to_equity: null,
    profit_margins: null,
    revenue_growth: null,
    source: null,
  };
}

/** Compact text summary for the Copilot tool / model context. */
export function summarizeResearch(r: TickerResearch): string {
  const id = r.identity;
  const lines: string[] = [
    `${id.ticker}${id.name ? ` — ${id.name}` : ""} (security_id=${id.security_id}` +
      `${id.figi ? `, figi=${id.figi}` : ""}${id.composite_figi ? `, composite_figi=${id.composite_figi}` : ""})`,
  ];
  if (r.price.spot != null) {
    const chg = r.price.change_1d_pct != null ? `, 1d ${fmtPct(r.price.change_1d_pct)}` : "";
    const chg5 = r.price.change_5d_pct != null ? `, 5d ${fmtPct(r.price.change_5d_pct)}` : "";
    const chg21 = r.price.change_21d_pct != null ? `, 21d ${fmtPct(r.price.change_21d_pct)}` : "";
    lines.push(`Spot ${r.price.spot.toFixed(2)}${chg}${chg5}${chg21}`);
  }
  if (r.price.volume_relative_20d != null) {
    lines.push(`Volume vs 20d avg: ${(r.price.volume_relative_20d * 100).toFixed(0)}%`);
  }
  lines.push(
    `Technicals: trend=${r.technicals.trend}, consolidation=${r.technicals.consolidation}` +
      `${r.technicals.consolidation_range_pct != null ? ` (${r.technicals.consolidation_range_pct.toFixed(1)}% range)` : ""}, ` +
      `accumulation=${r.technicals.accumulation}`,
  );
  for (const note of r.technicals.notes.slice(0, 3)) lines.push(`- ${note}`);
  const f = r.fundamentals;
  if (f.market_cap != null || f.trailing_pe != null || f.total_debt != null) {
    lines.push(
      `Fundamentals: marketCap=${fmtNum(f.market_cap)}, trailingPE=${fmtNum(f.trailing_pe)}, ` +
        `forwardPE=${fmtNum(f.forward_pe)}, totalDebt=${fmtNum(f.total_debt)}, D/E=${fmtNum(f.debt_to_equity)}`,
    );
  }
  if (r.earnings.length) {
    const next = r.earnings[0];
    lines.push(
      `Next/recent earnings: ${next.earnings_date}${next.time ? ` ${next.time}` : ""}` +
        `${next.eps_forecast != null ? `, EPS est ${next.eps_forecast}` : ""}`,
    );
  }
  if (r.news.length) {
    lines.push("Recent news:");
    for (const item of r.news.slice(0, 4)) lines.push(`- ${item.title} — ${item.link}`);
  }
  lines.push(`Research ${r.cache_hit ? "cache hit" : "fresh"} @ ${r.computed_at}`);
  return lines.join("\n");
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtNum(v: number | null): string {
  if (v == null) return "n/a";
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toFixed(2);
}

export function parseTickerParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = normalizeTicker(raw);
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)) return null;
  return t;
}
