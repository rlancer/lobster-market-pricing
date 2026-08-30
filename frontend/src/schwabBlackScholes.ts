/** Risk-free rate used for Performance option marks. Not from the lake. */
export const BS_RATE = 0.045;
export const BS_DIVIDEND = 0;
export const BS_MIN_YEARS = 1 / 365.25;

/**
 * Standard-normal CDF. Hastings approximation, absolute error ~7.5e-8.
 */
export function normCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const p = d * t * (
    0.319381530
    + t * (-0.356563782
      + t * (1.781477937
        + t * (-1.821255978 + t * 1.330274429)))
  );
  return x >= 0 ? 1 - p : p;
}

export function occExpirationIso(yyMMdd: string): string | null {
  if (!/^\d{6}$/.test(yyMMdd)) return null;
  const yy = Number(yyMMdd.slice(0, 2));
  const year = yy >= 80 ? 1900 + yy : 2000 + yy;
  return `${year}-${yyMMdd.slice(2, 4)}-${yyMMdd.slice(4, 6)}`;
}

export function yearFraction(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T12:00:00.000Z`);
  const b = Date.parse(`${toIso}T12:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return BS_MIN_YEARS;
  return Math.max((b - a) / (365.25 * 86_400_000), BS_MIN_YEARS);
}

export function intrinsicValue(
  right: 'C' | 'P',
  spot: number,
  strike: number,
): number {
  return right === 'P' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
}

export function blackScholesPrice(opts: {
  right: 'C' | 'P';
  spot: number;
  strike: number;
  years: number;
  vol: number;
  rate?: number;
  dividend?: number;
}): number {
  const S = opts.spot;
  const K = opts.strike;
  const T = Math.max(opts.years, BS_MIN_YEARS);
  const sigma = Math.max(opts.vol, 0);
  const r = opts.rate ?? BS_RATE;
  const q = opts.dividend ?? BS_DIVIDEND;
  if (!(S > 0) || !(K > 0) || !Number.isFinite(S) || !Number.isFinite(K)) return 0;
  if (sigma === 0) {
    const fwd = S * Math.exp((r - q) * T);
    const disc = Math.exp(-r * T);
    return opts.right === 'P'
      ? Math.max(K - fwd, 0) * disc
      : Math.max(fwd - K, 0) * disc;
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const dfS = Math.exp(-q * T);
  const dfK = Math.exp(-r * T);
  if (opts.right === 'C') {
    return S * dfS * normCdf(d1) - K * dfK * normCdf(d2);
  }
  return K * dfK * normCdf(-d2) - S * dfS * normCdf(-d1);
}

/** Equity options can be assigned — never mark below intrinsic. */
export function americanOptionMark(opts: {
  right: 'C' | 'P';
  spot: number;
  strike: number;
  years: number;
  vol: number;
  rate?: number;
  dividend?: number;
}): number {
  return Math.max(
    blackScholesPrice(opts),
    intrinsicValue(opts.right, opts.spot, opts.strike),
  );
}

/**
 * Invert European BS to the fill. Returns 0 when the fill is at/below
 * intrinsic (no time value to imply). Null if the quote cannot be priced.
 */
export function impliedVol(opts: {
  right: 'C' | 'P';
  spot: number;
  strike: number;
  years: number;
  price: number;
  rate?: number;
  dividend?: number;
}): number | null {
  const price = opts.price;
  if (!Number.isFinite(price) || price < 0) return null;
  const intrinsic = intrinsicValue(opts.right, opts.spot, opts.strike);
  if (price <= intrinsic + 1e-6) return 0;

  const at = (vol: number) => blackScholesPrice({ ...opts, vol });
  const loPrice = at(0);
  const hiPrice = at(5);
  if (price <= loPrice + 1e-8) return 0;
  if (price >= hiPrice) return 5;

  let lo = 1e-6;
  let hi = 5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
