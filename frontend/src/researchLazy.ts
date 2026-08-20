import type { TickerResearch } from './api';

/**
 * Fire `onArm` once when `#elementId` nears the viewport.
 * Falls back to immediate arm when IntersectionObserver is unavailable.
 */
export function observeOnce(
  elementId: string,
  onArm: () => void,
  opts?: { rootMargin?: string },
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onArm();
    return () => {};
  }
  const node = document.getElementById(elementId);
  if (!(node instanceof Element)) {
    onArm();
    return () => {};
  }
  let armed = false;
  const observer = new IntersectionObserver(
    (entries) => {
      if (armed) return;
      if (entries.some((e) => e.isIntersecting)) {
        armed = true;
        onArm();
        observer.disconnect();
      }
    },
    { rootMargin: opts?.rootMargin ?? '120px 0px' },
  );
  observer.observe(node);
  return () => observer.disconnect();
}

/** Schedule work after the browser is idle (or a short timeout fallback). */
export function whenIdle(task: () => void, timeoutMs = 1200): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  const cic = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(() => task(), { timeout: timeoutMs });
    return () => { if (typeof cic === 'function') cic(id); };
  }
  const id = globalThis.setTimeout(task, Math.min(timeoutMs, 200));
  return () => globalThis.clearTimeout(id);
}

/** URL-ticker shell so the brief layout paints before GET /api/research returns. */
export function pendingTickerResearch(ticker: string): TickerResearch {
  const symbol = ticker.trim().toUpperCase();
  return {
    identity: {
      security_id: '',
      ticker: symbol,
      figi: null,
      composite_figi: null,
      isin: null,
      name: null,
      exchange: null,
      currency: null,
      sector: null,
      source: 'ticker',
      resolved_at: 0,
    },
    price: {
      spot: null,
      change_1d_pct: null,
      change_5d_pct: null,
      change_21d_pct: null,
      change_63d_pct: null,
      high_63d: null,
      low_63d: null,
      volume_latest: null,
      volume_avg_20d: null,
      volume_relative_20d: null,
    },
    technicals: {
      trend: 'unknown',
      consolidation: false,
      consolidation_range_pct: null,
      accumulation: 'unknown',
      notes: [],
    },
    realized_vol: null,
    fundamentals: {
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
    },
    earnings: [],
    news: [],
    filings: [],
    etf: null,
    computed_at: '',
    expires_at: '',
    cache_hit: false,
  };
}

export function isResearchBriefReady(research: TickerResearch | null | undefined): boolean {
  return Boolean(research?.computed_at);
}
