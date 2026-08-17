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

function yearStart(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/**
 * Slice daily lake bars for the selected range.
 * - 1D: last session (intraday series is loaded separately in the chart).
 * - MTD / YTD: calendar filters in America/New_York.
 * - 1M / 3M / 6M / 1Y: trailing session counts.
 * - ALL: full series.
 */
export function sliceBars(
  bars: OhlcBar[],
  range: ChartRange,
  asOfDate: string = etDateString(),
): OhlcBar[] {
  if (range === 'ALL') return bars;
  if (range === 'YTD') {
    const start = yearStart(asOfDate);
    return bars.filter((b) => b.date >= start);
  }
  if (range === 'MTD') {
    const start = monthStart(asOfDate);
    return bars.filter((b) => b.date >= start);
  }
  if (range === '1D') {
    return bars.length ? bars.slice(-1) : bars;
  }
  const n = RANGE_BARS[range];
  if (n == null || bars.length <= n) return bars;
  return bars.slice(-n);
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
