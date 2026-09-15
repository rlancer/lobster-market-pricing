export const KALSHI_PARLAY_BOOKS_SLUG = 'kalshi-parlay-books';
export const KALSHI_PARLAY_PAYOFFS_SLUG = 'kalshi-parlay-payoffs';
export const KALSHI_PARLAY_BOOKS_DESIGN_ID = 'kalshi-parlay-books-v1';

export function fmtRr(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}:1`;
}

export function pnlTone(value: number | null | undefined): 'green' | 'red' | 'gray' {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.005) return 'gray';
  return value > 0 ? 'green' : 'red';
}
