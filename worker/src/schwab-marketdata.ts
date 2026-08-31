/**
 * Charles Schwab Market Data API — daily price history for Performance.
 *
 * Uses the connected user's Trader OAuth token (scope `api`). Tokens never
 * leave the Worker. Daily candles feed the ticker stock P&L path so we mark
 * to the same book the user is connected with, not the lake/Yahoo series.
 */

import { SchwabApiError } from "./schwab-portfolio";
import { dayBoundsIso, etDateString } from "./schwab-trader";

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
