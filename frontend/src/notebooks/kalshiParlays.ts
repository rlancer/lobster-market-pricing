/** Kalshi parlay experiment — public labels + formatting. */

export const KALSHI_PARLAY_SLUG = 'kalshi-parlays';
export const KALSHI_PARLAY_DESIGN_ID = 'kalshi-parlays-v1';

export function fmtProb(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}¢`;
}

export function fmtRho(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

export function fmtGap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const cents = value * 100;
  const sign = cents > 0 ? '+' : '';
  return `${sign}${cents.toFixed(1)}¢`;
}

export function flagLabel(flag: string): string {
  switch (flag) {
    case 'independence_gap':
      return 'vs independent';
    case 'copula_gap':
      return 'vs copula';
    case 'above_frechet':
      return 'above Fréchet';
    case 'below_frechet':
      return 'below Fréchet';
    default:
      return flag;
  }
}

export function gapTone(value: number | null | undefined): 'green' | 'red' | 'gray' {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.02) return 'gray';
  return value > 0 ? 'green' : 'red';
}
