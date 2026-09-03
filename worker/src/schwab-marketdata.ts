/**
 * Charles Schwab Market Data API — daily price history + live quotes.
 *
 * Uses the connected user's Trader OAuth token (scope `api`). Tokens never
 * leave the Worker. Callers MUST pass a resolved owner user_id — never pick
 * a row from schwab_connections without one. Daily candles feed Performance
 * P&L; quotes power Copilot get_schwab_quotes for that same owner only.
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";
import { SchwabApiError } from "./schwab-portfolio";
import { dayBoundsIso, etDateString } from "./schwab-trader";
import { kindFromSchwabAssetType } from "./symbol-identity";

export const SCHWAB_MARKETDATA_BASE = "https://api.schwabapi.com/marketdata/v1";

/** Calendar days before chart start so the first in-window close has a prior. */
export const PRICE_HISTORY_PRIOR_PAD_DAYS = 21;

export interface SchwabPriceBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Bucket a Schwab candle timestamp onto the America/New_York session date. */
export function candleSessionDate(datetimeMs: number): string {
  return etDateString(new Date(datetimeMs));
}

export function priceHistoryLookbackStart(
  chartStart: string,
  padDays = PRICE_HISTORY_PRIOR_PAD_DAYS,
): string {
  const ms = Date.parse(`${chartStart}T12:00:00.000Z`);
  if (!Number.isFinite(ms)) return chartStart;
  return new Date(ms - padDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isPriceHistorySymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (/^[A-Z0-9./\-]{1,10}$/.test(s)) return true;
  const compact = s.replace(/\s+/g, "");
  return /^[A-Z0-9.\-]{1,6}\d{6}[CP]\d{8}$/.test(compact);
}

/**
 * Normalize Schwab `/pricehistory` JSON. `previousClose` (when asked for)
 * becomes an extra bar so MTD/1M has a prior close before range start.
 */
export function normalizeSchwabPriceHistory(payload: unknown): SchwabPriceBar[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = payload as {
    empty?: boolean;
    candles?: Array<{
      open?: unknown;
      high?: unknown;
      low?: unknown;
      close?: unknown;
      volume?: unknown;
      datetime?: unknown;
    }>;
    previousClose?: unknown;
    previousCloseDate?: unknown;
  };

  const out: SchwabPriceBar[] = [];
  const seen = new Set<string>();
  const push = (
    date: string,
    close: number | null,
    extra?: { open?: number | null; high?: number | null; low?: number | null; volume?: number | null },
  ) => {
    if (!date || close == null || !Number.isFinite(close)) return;
    if (seen.has(date)) return;
    seen.add(date);
    out.push({
      date,
      open: extra?.open ?? null,
      high: extra?.high ?? null,
      low: extra?.low ?? null,
      close,
      volume: extra?.volume ?? null,
    });
  };

  const prevClose = num(raw.previousClose);
  const prevMs = num(raw.previousCloseDate);
  if (prevClose != null && prevMs != null) {
    push(candleSessionDate(prevMs), prevClose);
  }

  for (const candle of raw.candles ?? []) {
    const ms = num(candle.datetime);
    if (ms == null) continue;
    push(candleSessionDate(ms), num(candle.close), {
      open: num(candle.open),
      high: num(candle.high),
      low: num(candle.low),
      volume: num(candle.volume),
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Daily OHLC for `symbol` from `start` through `end` (ET), plus a short
 * lookback so the first session has a prior close. Empty on a bad ticker.
 */
export async function fetchSchwabPriceHistory(
  accessToken: string,
  opts: { symbol: string; start: string; end: string },
  tokenType = "Bearer",
  fetchImpl: typeof fetch = fetch,
): Promise<SchwabPriceBar[]> {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!isPriceHistorySymbol(symbol)) return [];

  const lookbackStart = priceHistoryLookbackStart(opts.start);
  const { startIso, endIso } = dayBoundsIso(lookbackStart, opts.end);
  const url = new URL(`${SCHWAB_MARKETDATA_BASE}/pricehistory`);
  url.searchParams.set("symbol", symbol);
  // periodType=year is required for frequencyType=daily. period=2 so a 1Y
  // chart plus the prior-close pad is not clipped to 365 sessions.
  url.searchParams.set("periodType", "year");
  url.searchParams.set("period", "2");
  url.searchParams.set("frequencyType", "daily");
  url.searchParams.set("frequency", "1");
  url.searchParams.set("startDate", String(Date.parse(startIso)));
  url.searchParams.set("endDate", String(Date.parse(endIso)));
  url.searchParams.set("needExtendedHoursData", "false");
  url.searchParams.set("needPreviousClose", "true");

  const resp = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new SchwabApiError(resp.status, text);
  }
  if (resp.status === 204) return [];
  return normalizeSchwabPriceHistory(await resp.json());
}

/** Normalize Schwab quote fundamentals into a decimal continuous yield. */
export function normalizeSchwabDividendYield(
  payload: unknown,
  symbol: string,
  fallbackSpot?: number | null,
): number | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = payload as Record<string, unknown>;
  const raw = rows[symbol.toUpperCase()] ?? rows[symbol] ?? payload;
  if (!raw || typeof raw !== "object") return null;
  const quote = raw as {
    fundamental?: { divYield?: unknown; divAmount?: unknown };
    quote?: { lastPrice?: unknown; mark?: unknown; closePrice?: unknown };
  };
  const reportedYield = num(quote.fundamental?.divYield);
  if (reportedYield != null && reportedYield >= 0) {
    // Schwab quote fundamentals express divYield in percentage points.
    return reportedYield / 100;
  }
  const annualAmount = num(quote.fundamental?.divAmount);
  const spot =
    num(quote.quote?.lastPrice)
    ?? num(quote.quote?.mark)
    ?? num(quote.quote?.closePrice)
    ?? fallbackSpot
    ?? null;
  if (annualAmount == null || annualAmount < 0 || spot == null || spot <= 0) return null;
  return annualAmount / spot;
}

/** Current dividend yield used by the option mark model. */
export async function fetchSchwabDividendYield(
  accessToken: string,
  symbol: string,
  tokenType = "Bearer",
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const normalized = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9./\-]{1,10}$/.test(normalized)) return null;
  const url = new URL(`${SCHWAB_MARKETDATA_BASE}/quotes`);
  url.searchParams.set("symbols", normalized);
  url.searchParams.set("fields", "fundamental");
  const resp = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new SchwabApiError(resp.status, text);
  }
  if (resp.status === 204) return null;
  return normalizeSchwabDividendYield(await resp.json(), normalized);
}

/** Cap on Copilot /quotes batch size — keep the Schwab request small. */
export const SCHWAB_QUOTES_MAX = 20;

export interface SchwabQuote {
  symbol: string;
  description: string | null;
  /** Schwab `reference.assetMainType` (EQUITY, COLLECTIVE_INVESTMENT, …). */
  asset_type: string | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  net_change: number | null;
  net_pct: number | null;
  volume: number | null;
  quote_time: string | null;
  delayed: boolean;
}

export type SchwabQuotesLoadResult =
  | { ok: true; quotes: SchwabQuote[] }
  | {
      ok: false;
      reason: "not_connected" | "refresh_failed" | "upstream" | "no_symbols";
      message?: string;
      status?: number;
    };

/** Equities, indexes ($SPX), futures (/ES), and OCC option symbols. */
export function isQuoteSymbol(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (/^[/$]?[A-Z0-9][A-Z0-9./\-]{0,14}$/.test(s)) return true;
  const compact = s.replace(/\s+/g, "");
  return /^[A-Z0-9.\-]{1,6}\d{6}[CP]\d{8}$/.test(compact);
}

/** Uppercase, unique, valid symbols — never accepts a user id. */
export function sanitizeQuoteSymbols(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const symbol = item.trim().toUpperCase();
    if (!isQuoteSymbol(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
    if (out.length >= SCHWAB_QUOTES_MAX) break;
  }
  return out;
}

function quoteTimeIso(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function readQuoteRow(raw: unknown, fallbackSymbol: string): SchwabQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    symbol?: unknown;
    delayed?: unknown;
    reference?: { description?: unknown; assetMainType?: unknown; assetSubType?: unknown };
    quote?: {
      lastPrice?: unknown;
      bidPrice?: unknown;
      askPrice?: unknown;
      mark?: unknown;
      openPrice?: unknown;
      highPrice?: unknown;
      lowPrice?: unknown;
      closePrice?: unknown;
      netChange?: unknown;
      netPercentChange?: unknown;
      netPercentChangeInDouble?: unknown;
      totalVolume?: unknown;
      quoteTime?: unknown;
      tradeTime?: unknown;
    };
  };
  const symbol = typeof row.symbol === "string" && row.symbol.trim()
    ? row.symbol.trim().toUpperCase()
    : fallbackSymbol;
  if (!symbol) return null;
  const q = row.quote ?? {};
  const last = num(q.lastPrice);
  const mark = num(q.mark);
  const close = num(q.closePrice);
  if (last == null && mark == null && close == null && num(q.bidPrice) == null && num(q.askPrice) == null) {
    return null;
  }
  const assetType =
    typeof row.reference?.assetMainType === "string" && row.reference.assetMainType.trim()
      ? row.reference.assetMainType.trim()
      : null;
  return {
    symbol,
    description: typeof row.reference?.description === "string" ? row.reference.description : null,
    asset_type: assetType,
    last,
    bid: num(q.bidPrice),
    ask: num(q.askPrice),
    mark,
    open: num(q.openPrice),
    high: num(q.highPrice),
    low: num(q.lowPrice),
    close,
    net_change: num(q.netChange),
    net_pct: num(q.netPercentChangeInDouble) ?? num(q.netPercentChange),
    volume: num(q.totalVolume),
    quote_time: quoteTimeIso(num(q.quoteTime) ?? num(q.tradeTime)),
    delayed: row.delayed === true,
  };
}

/** Normalize Schwab `/quotes` JSON keyed by symbol. */
export function normalizeSchwabQuotes(payload: unknown, requested: string[] = []): SchwabQuote[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = payload as Record<string, unknown>;
  const out: SchwabQuote[] = [];
  const seen = new Set<string>();
  const keys = requested.length > 0
    ? requested
    : Object.keys(rows).filter((key) => key !== "empty");
  for (const key of keys) {
    const raw = rows[key] ?? rows[key.toUpperCase()] ?? rows[key.toLowerCase()];
    const quote = readQuoteRow(raw, key.toUpperCase());
    if (!quote || seen.has(quote.symbol)) continue;
    seen.add(quote.symbol);
    out.push(quote);
  }
  return out;
}

export function formatSchwabQuotesSummary(quotes: SchwabQuote[]): string {
  if (quotes.length === 0) return "Schwab quotes: no prints returned for those symbols.";
  const lines = [`Schwab quotes (${quotes.length})`];
  for (const q of quotes) {
    const last = q.last ?? q.mark ?? q.close;
    const chg = q.net_change != null
      ? `${q.net_change >= 0 ? "+" : ""}${q.net_change.toFixed(2)}`
      : null;
    const pct = q.net_pct != null
      ? `${q.net_pct >= 0 ? "+" : ""}${q.net_pct.toFixed(2)}%`
      : null;
    const move = [chg, pct].filter(Boolean).join(" ");
    const bidask = q.bid != null && q.ask != null ? `bid ${q.bid} / ask ${q.ask}` : null;
    const kind = kindFromSchwabAssetType(q.asset_type);
    const kindLabel = kind === "unknown" && q.asset_type
      ? q.asset_type.toLowerCase()
      : (kind !== "unknown" ? kind : null);
    lines.push(
      [
        q.symbol,
        kindLabel,
        q.description,
        last != null ? `last ${last}` : null,
        bidask,
        q.mark != null && q.mark !== last ? `mark ${q.mark}` : null,
        move || null,
        q.volume != null ? `vol ${q.volume}` : null,
        q.delayed ? "delayed" : null,
      ].filter(Boolean).join(" · "),
    );
  }
  return lines.join("\n");
}

/**
 * Batch quotes. `accessToken` must already belong to the resolved owner —
 * this helper does not look up connections.
 */
export async function fetchSchwabQuotes(
  accessToken: string,
  symbols: string[],
  tokenType = "Bearer",
  fetchImpl: typeof fetch = fetch,
): Promise<SchwabQuote[]> {
  const cleaned = sanitizeQuoteSymbols(symbols);
  if (cleaned.length === 0) return [];

  const url = new URL(`${SCHWAB_MARKETDATA_BASE}/quotes`);
  url.searchParams.set("symbols", cleaned.join(","));
  url.searchParams.set("fields", "quote,reference");
  const resp = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new SchwabApiError(resp.status, text);
  }
  if (resp.status === 204) return [];
  return normalizeSchwabQuotes(await resp.json(), cleaned);
}

/**
 * Load quotes for one user_id only. Looks up schwab_connections WHERE user_id = ?
 * — never scans other rows, never accepts a token from the caller.
 */
export async function loadSchwabQuotesForUser(
  env: SchwabEnv,
  userId: string,
  symbols: string[],
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<SchwabQuotesLoadResult> {
  const owner = userId.trim();
  if (!owner) return { ok: false, reason: "not_connected" };

  const cleaned = sanitizeQuoteSymbols(symbols);
  if (cleaned.length === 0) {
    return { ok: false, reason: "no_symbols", message: "No valid symbols to quote." };
  }

  let token: { accessToken: string; tokenType: string } | null;
  try {
    token = await getValidAccessToken(env, owner, now);
  } catch (e) {
    return {
      ok: false,
      reason: "refresh_failed",
      status: 401,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!token) return { ok: false, reason: "not_connected" };

  try {
    const quotes = await fetchSchwabQuotes(token.accessToken, cleaned, token.tokenType, fetchImpl);
    return { ok: true, quotes };
  } catch (e) {
    if (e instanceof SchwabApiError) {
      return { ok: false, reason: "upstream", status: e.status, message: e.message };
    }
    return {
      ok: false,
      reason: "upstream",
      status: 502,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
