/** Cash vol indexes and monthly VX quotes belong on `/vix`, not ticker research. */

const MONTHLY_VX_QUOTE = /^VX[FGHJKMNQUVXZ]\d{2}$/;
const CASH_VIX_INDEXES = new Set(['^VIX', '^VIX9D', '^VIX3M', '^VVIX']);

export function isVixPageTicker(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  const index = t.startsWith('^') ? t : `^${t}`;
  return CASH_VIX_INDEXES.has(index) || MONTHLY_VX_QUOTE.test(t);
}

export type TickerLink =
  | { to: '/vix' }
  | { to: '/research/$ticker'; params: { ticker: string } };

export function tickerLink(ticker: string): TickerLink {
  if (isVixPageTicker(ticker)) return { to: '/vix' };
  return { to: '/research/$ticker', params: { ticker } };
}

export function formatVixPx(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatVixPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (value > 0) return `+${abs}%`;
  if (value < 0) return `−${abs}%`;
  return `${abs}%`;
}

export function formatVixPts(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

export function changeTone(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export function shortVixDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function tenorChartLabel(tenor: number): string {
  return tenor === 0 ? 'Spot' : `M${tenor}`;
}

export function defaultOverlayDate(asOf: string, settlementDates: string[]): string | null {
  return settlementDates.find((date) => date < asOf) ?? null;
}
