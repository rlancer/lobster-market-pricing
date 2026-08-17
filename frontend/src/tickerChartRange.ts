import type { OhlcBar } from './api';

export type ChartRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export const RANGE_BARS: Record<ChartRange, number | null> = {
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252,
  ALL: null,
};

export const CHART_RANGES: ChartRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

export function sliceBars(bars: OhlcBar[], range: ChartRange): OhlcBar[] {
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
