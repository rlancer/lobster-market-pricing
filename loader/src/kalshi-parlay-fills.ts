/**
 * Executor fill tape — source tag + parse helpers shared with the Worker
 * backtest. Ingest (GET /portfolio/fills → pipeline) lives in
 * kalshi-parlay-tape.ts so the Worker does not import loader/src/kalshi.ts.
 */

import { seriesTickerFromMarketTicker } from "./kalshi-mve.js";

export const KALSHI_PARLAY_FILL_SOURCE = "kalshi_parlay_fill";
export const PARLAY_FILL_YES = "buy_yes";
export const PARLAY_FILL_NO = "buy_no";

export interface ParlayPortfolioFill {
  market_ticker: string;
  side: "yes" | "no";
  contracts: number;
  yes_price: number;
  no_price: number;
  fee: number;
  created_time: string;
}

export interface ParlayPortfolioSettlement {
  market_ticker: string;
  revenue: number;
  settled_time: string | null;
}

export interface ParlayExecutorQuote {
  market_ticker: string;
  yes_bid: number | null;
  yes_ask: number | null;
}

export interface ParlayFillMarketRow {
  series_ticker: string;
  market_ticker: string;
  event_ticker: string | null;
  title: string;
  yes_subtitle: string | null;
  theme: "sports";
  category: string | null;
  status: string;
  market_type: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  no_bid: number | null;
  no_ask: number | null;
  volume: number | null;
  volume_24h: number | null;
  open_interest: number | null;
  liquidity: number | null;
  floor_strike: number | null;
  close_time: string | null;
  expiration_time: string | null;
  related_symbol: string | null;
  source: string;
  fetched_at?: string;
  result?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function num(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const s = strip(raw);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function isKalshiParlayFillSource(source: string | null | undefined): boolean {
  return String(source ?? "").trim().toLowerCase() === KALSHI_PARLAY_FILL_SOURCE;
}

export function isParlayComboTicker(ticker: string): boolean {
  return /KXMVE/i.test(ticker);
}

export function parseFillSide(subtitle: string | null | undefined): "yes" | "no" | null {
  const raw = String(subtitle ?? "").trim().toLowerCase();
  if (raw === PARLAY_FILL_YES || raw === "yes") return "yes";
  if (raw === PARLAY_FILL_NO || raw === "no") return "no";
  return null;
}

export function parseKalshiPortfolioFill(raw: unknown): ParlayPortfolioFill | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const market_ticker = strip(rec.ticker || rec.market_ticker).toUpperCase();
  if (!market_ticker || !isParlayComboTicker(market_ticker)) return null;
  const action = strip(rec.action).toLowerCase();
  if (action && action !== "buy") return null;
  const sideRaw = strip(rec.side || rec.outcome_side).toLowerCase();
  const side: "yes" | "no" | null = sideRaw === "no" ? "no" : sideRaw === "yes" ? "yes" : null;
  if (!side) return null;
  const contracts = num(rec.count_fp ?? rec.count ?? rec.contracts);
  const yes_price = num(rec.yes_price_dollars ?? rec.yes_price);
  const no_price = num(rec.no_price_dollars ?? rec.no_price)
    ?? (yes_price != null ? 1 - yes_price : null);
  const fee = num(rec.fee_cost) ?? 0;
  const created_time = strip(rec.created_time || rec.ts);
  if (contracts == null || contracts <= 0 || yes_price == null || no_price == null || !created_time) {
    return null;
  }
  return { market_ticker, side, contracts, yes_price, no_price, fee, created_time };
}

export function parseKalshiPortfolioSettlement(raw: unknown): ParlayPortfolioSettlement | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const market_ticker = strip(rec.ticker || rec.market_ticker).toUpperCase();
  if (!market_ticker || !isParlayComboTicker(market_ticker)) return null;
  const revenue = num(rec.revenue ?? rec.revenue_dollars);
  if (revenue == null) return null;
  return {
    market_ticker,
    revenue,
    settled_time: strip(rec.settled_time) || null,
  };
}

/** Portfolio revenue > 0 means the filled side paid $1/contract. */
export function settlementYesFromFill(
  fill: Pick<ParlayPortfolioFill, "side">,
  revenue: number | null | undefined,
): 0 | 1 | null {
  if (revenue == null || !Number.isFinite(revenue)) return null;
  const filledSideWon = revenue > 0;
  if (fill.side === "no") return filledSideWon ? 0 : 1;
  return filledSideWon ? 1 : 0;
}

export function fillToMarketRow(
  fill: ParlayPortfolioFill,
  prior?: Partial<ParlayFillMarketRow> | null,
  category?: string | null,
): ParlayFillMarketRow {
  const ticker = fill.market_ticker;
  return {
    series_ticker: prior?.series_ticker || seriesTickerFromMarketTicker(ticker),
    market_ticker: ticker,
    event_ticker: prior?.event_ticker ?? null,
    title: prior?.title || ticker,
    yes_subtitle: fill.side === "yes" ? PARLAY_FILL_YES : PARLAY_FILL_NO,
    theme: "sports",
    category: category ?? prior?.category ?? null,
    status: prior?.status || "active",
    market_type: prior?.market_type || "multivariate",
    yes_bid: fill.yes_price,
    yes_ask: fill.yes_price,
    yes_last: fill.yes_price,
    no_bid: fill.no_price,
    no_ask: fill.no_price,
    volume: fill.contracts,
    volume_24h: null,
    open_interest: null,
    liquidity: fill.fee,
    floor_strike: null,
    close_time: prior?.close_time ?? null,
    expiration_time: prior?.expiration_time ?? null,
    related_symbol: null,
    source: KALSHI_PARLAY_FILL_SOURCE,
    fetched_at: fill.created_time,
  };
}
