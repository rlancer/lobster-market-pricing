import type { OhlcBar } from './api';

export type ChartRange = '1D' | 'MTD' | 'YTD' | '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const RANGE_BARS: Record<ChartRange, number | null> = {
  '1D': 1,
  MTD: null,
  YTD: null,
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252,
  ALL: null,
};

export const CHART_RANGES: ChartRange[] = ['1D', 'MTD', 'YTD', '1M', '3M', '6M', '1Y', 'ALL'];

export function chartRangeLabel(range: ChartRange): string {
  if (range === '1D') return 'Day';
  if (range === 'ALL') return 'All';
  return range;
}

/** Exchange-calendar date (US equities) as YYYY-MM-DD. */
export function etDateString(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Bucket a timestamp onto the ET trading calendar (same rules as the Worker).
 * Date-only `YYYY-MM-DD` is kept; ISO times convert through America/New_York.
 */
export function etTradeDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  if (Number.isFinite(ms)) return etDateString(new Date(ms));
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : null;
}

function yearStart(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** Keep bars whose ET trade day is on or before `asOfDate`. */
export function clipBarsToAsOf(bars: OhlcBar[], asOfDate: string): OhlcBar[] {
  return bars.filter((bar) => {
    const day = etTradeDay(bar.date) ?? bar.date.slice(0, 10);
    return day <= asOfDate;
  });
}

export type AsOfQuote = {
  spot: number | null;
  change_1d_pct: number | null;
  change_5d_pct: number | null;
  change_21d_pct: number | null;
};

function sessionChange(closes: number[], sessions: number): number | null {
  if (closes.length <= sessions) return null;
  const last = closes.at(-1);
  const prev = closes.at(-1 - sessions);
  if (last == null || prev == null || prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

/** Last lake close on/before as-of, plus 1d / 5d / 21d session returns. */
export function asOfQuote(bars: OhlcBar[], asOfDate: string): AsOfQuote {
  const closes = clipBarsToAsOf(bars, asOfDate)
    .map((bar) => bar.close)
    .filter((close): close is number => close != null && Number.isFinite(close));
  return {
    spot: closes.at(-1) ?? null,
    change_1d_pct: sessionChange(closes, 1),
    change_5d_pct: sessionChange(closes, 5),
    change_21d_pct: sessionChange(closes, 21),
  };
}

/**
 * Slice daily lake bars for the selected range, relative to `asOfDate`.
 * Bars after as-of are dropped first, then:
 * - 1D: last session on/before as-of (intraday is live-only).
 * - MTD / YTD: calendar filters in America/New_York.
 * - 1M / 3M / 6M / 1Y: trailing session counts from the clipped end.
 * - ALL: clipped series.
 */
export function sliceBars(
  bars: OhlcBar[],
  range: ChartRange,
  asOfDate: string = etDateString(),
): OhlcBar[] {
  const clipped = clipBarsToAsOf(bars, asOfDate);
  if (range === 'ALL') return clipped;
  if (range === 'YTD') {
    const start = yearStart(asOfDate);
    return clipped.filter((b) => (etTradeDay(b.date) ?? b.date) >= start);
  }
  if (range === 'MTD') {
    const start = monthStart(asOfDate);
    return clipped.filter((b) => (etTradeDay(b.date) ?? b.date) >= start);
  }
  if (range === '1D') {
    return clipped.length ? clipped.slice(-1) : clipped;
  }
  const n = RANGE_BARS[range];
  if (n == null || clipped.length <= n) return clipped;
  return clipped.slice(-n);
}

/** First→last close return over the visible bars (null when too thin). */
export function rangeMove(bars: OhlcBar[]): { pct: number; abs: number } | null {
  let first: number | null = null;
  let last: number | null = null;
  let n = 0;
  for (const bar of bars) {
    const c = bar.close;
    if (c == null || !Number.isFinite(c)) continue;
    if (first == null) first = c;
    last = c;
    n += 1;
  }
  if (n < 2 || first == null || last == null || first === 0) return null;
  return { abs: last - first, pct: ((last - first) / first) * 100 };
}

/** X-axis tick: HH:MM for intraday (`…T…`), else MM-DD. */
export function formatChartTick(d: string): string {
  if (typeof d !== 'string') return String(d);
  const tIdx = d.indexOf('T');
  if (tIdx >= 0) {
    const time = d.slice(tIdx + 1, tIdx + 6);
    return time.length === 5 ? time : d.slice(5, 10);
  }
  return d.length >= 10 ? d.slice(5, 10) : d;
}
