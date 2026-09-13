/**
 * Kalshi parlay / combo pricing math.
 *
 * Listed Fed combos (KXFEDCOMBO) are a 2×2 of rate-decision × dissent. Sports
 * MVEs exist on Kalshi but are RFQ-first; this module prices any two binary
 * legs against independence, Fréchet bounds, Bernoulli phi, and a Gaussian
 * copula (tetrachoric ρ).
 */

export const KALSHI_PARLAY_SLUG = "kalshi-parlays";
export const KALSHI_PARLAY_DESIGN_ID = "kalshi-parlays-v1";

export type FedRateKey = "hike_25" | "cut_25" | "hold";
export type FedDissentKey = "zero" | "some";

export interface KalshiQuote {
  series_ticker: string;
  ticker: string;
  event_ticker: string | null;
  title: string;
  yes_subtitle: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  volume: number | null;
  close_time: string | null;
  status: string;
}

export interface ParsedFedCombo {
  ticker: string;
  period: string;
  rate: FedRateKey;
  dissent: FedDissentKey;
}

export interface ParsedDecision {
  ticker: string;
  period: string;
  rate: FedRateKey;
}

export interface ParsedDissentCount {
  ticker: string;
  period: string;
  count: number;
}

const EPS = 1e-9;
const RHO_MAX = 0.999;

export function clampProb(p: number, lo = EPS, hi = 1 - EPS): number {
  if (!Number.isFinite(p)) return lo;
  return Math.min(hi, Math.max(lo, p));
}

export function parseKalshiNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Mid YES price in dollars (0–1). Prefer bid/ask mid, else last, else a one-sided quote. */
export function quoteMid(q: Pick<KalshiQuote, "yes_bid" | "yes_ask" | "yes_last">): number | null {
  const bid = q.yes_bid;
  const ask = q.yes_ask;
  if (
    bid != null && ask != null
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid >= 0 && ask <= 1 && ask >= bid
  ) {
    if (bid === 0 && ask === 1) {
      if (q.yes_last != null && Number.isFinite(q.yes_last) && q.yes_last > 0 && q.yes_last < 1) {
        return q.yes_last;
      }
      return null;
    }
    return round6((bid + ask) / 2);
  }
  if (q.yes_last != null && Number.isFinite(q.yes_last) && q.yes_last >= 0 && q.yes_last <= 1) {
    return q.yes_last;
  }
  if (bid != null && Number.isFinite(bid) && bid > 0 && bid < 1) return bid;
  if (ask != null && Number.isFinite(ask) && ask > 0 && ask < 1) return ask;
  return null;
}

export function quoteSpread(q: Pick<KalshiQuote, "yes_bid" | "yes_ask">): number | null {
  const bid = q.yes_bid;
  const ask = q.yes_ask;
  if (
    bid == null || ask == null
    || !Number.isFinite(bid) || !Number.isFinite(ask)
    || ask < bid
  ) {
    return null;
  }
  return round6(ask - bid);
}

export function isTwoSided(q: Pick<KalshiQuote, "yes_bid" | "yes_ask">): boolean {
  const bid = q.yes_bid;
  const ask = q.yes_ask;
  return bid != null && ask != null
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid > 0 && ask < 1 && ask >= bid;
}

export function independenceJoint(probs: number[]): number {
  return probs.reduce((acc, p) => acc * clampProb(p), 1);
}

/** Fréchet–Hoeffding lower bound for P(all). */
export function frechetLower(probs: number[]): number {
  if (!probs.length) return 0;
  return Math.max(0, probs.reduce((a, b) => a + b, 0) - (probs.length - 1));
}

/** Fréchet–Hoeffding upper bound for P(all) = min p_i. */
export function frechetUpper(probs: number[]): number {
  if (!probs.length) return 0;
  return Math.min(...probs.map((p) => clampProb(p, 0, 1)));
}

/**
 * Bernoulli phi (Pearson correlation of the two binary outcomes).
 * Zero under independence. Bounded by Fréchet, not ±1 in general.
 */
export function bernoulliPhi(p: number, q: number, joint: number): number | null {
  const pp = clampProb(p, 0, 1);
  const qq = clampProb(q, 0, 1);
  const den = Math.sqrt(pp * (1 - pp) * qq * (1 - qq));
  if (!(den > 0)) return null;
  return (joint - pp * qq) / den;
}

// --- Gaussian copula / tetrachoric ------------------------------------------------

/** Abramowitz & Stegun 7.1.26 erf. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Acklam's rational approximation to Φ⁻¹. */
export function normInv(pRaw: number): number {
  const p = clampProb(pRaw);
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577509590705e+02, -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** 16-point Gauss–Legendre nodes/weights on [-1, 1]. */
const GL16_X = [
  -0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.7554044083550030,
  -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.09501250983763744,
  0.09501250983763744, 0.2816035507792589, 0.4580167776572274, 0.6178762444026438,
  0.7554044083550030, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499,
];
const GL16_W = [
  0.02715245941175409, 0.06225352393864789, 0.09515851168249278, 0.12462897125553387,
  0.14959598881657673, 0.16915651939500254, 0.18260341504492359, 0.18945061045506850,
  0.18945061045506850, 0.18260341504492359, 0.16915651939500254, 0.14959598881657673,
  0.12462897125553387, 0.09515851168249278, 0.06225352393864789, 0.02715245941175409,
];

function integrateGL16(a: number, b: number, f: (s: number) => number): number {
  const mid = 0.5 * (a + b);
  const half = 0.5 * (b - a);
  let sum = 0;
  for (let i = 0; i < GL16_X.length; i++) {
    sum += GL16_W[i]! * f(mid + half * GL16_X[i]!);
  }
  return sum * half;
}

/**
 * Standard bivariate normal CDF Φ₂(h, k, ρ).
 * Uses Φ(h)Φ(k) plus the density-integral form in ρ.
 */
export function bivNormCdf(h: number, k: number, rhoRaw: number): number {
  const rho = Math.min(RHO_MAX, Math.max(-RHO_MAX, rhoRaw));
  if (!Number.isFinite(h) || !Number.isFinite(k)) return 0;
  if (Math.abs(rho) < 1e-12) return clampProb(normCdf(h) * normCdf(k), 0, 1);
  const base = normCdf(h) * normCdf(k);
  const integ = integrateGL16(0, rho, (s) => {
    const ss = s * s;
    const den = 1 - ss;
    if (den <= 1e-12) return 0;
    const expo = -((h * h + k * k - 2 * h * k * s) / (2 * den));
    return Math.exp(expo) / Math.sqrt(den);
  });
  return clampProb(base + integ / (2 * Math.PI), 0, 1);
}

/** P(A∩B) under a Gaussian copula with correlation ρ. */
export function gaussianCopulaJoint(p: number, q: number, rho: number): number {
  const pp = clampProb(p);
  const qq = clampProb(q);
  const r = Math.min(RHO_MAX, Math.max(-RHO_MAX, rho));
  if (Math.abs(r) < 1e-12) return pp * qq;
  return bivNormCdf(normInv(pp), normInv(qq), r);
}

/** Invert the Gaussian copula for implied (tetrachoric) ρ. */
export function impliedGaussianRho(p: number, q: number, joint: number): number | null {
  const pp = clampProb(p);
  const qq = clampProb(q);
  const lo = frechetLower([pp, qq]);
  const hi = frechetUpper([pp, qq]);
  if (!Number.isFinite(joint)) return null;
  const j = Math.min(hi, Math.max(lo, joint));
  let a = -RHO_MAX;
  let b = RHO_MAX;
  for (let i = 0; i < 48; i++) {
    const mid = 0.5 * (a + b);
    const est = gaussianCopulaJoint(pp, qq, mid);
    if (est < j) a = mid;
    else b = mid;
  }
  return 0.5 * (a + b);
}

export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i]! - mx;
    const ay = ys[i]! - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  const den = Math.sqrt(dx * dy);
  if (!(den > 0)) return null;
  const r = num / den;
  return Math.min(1, Math.max(-1, r));
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

// --- Fed combo tickers -------------------------------------------------------------

const RATE_FROM_COMBO: Record<string, FedRateKey> = {
  "25H": "hike_25",
  "25C": "cut_25",
  "0": "hold",
};

const RATE_FROM_DECISION: Record<string, FedRateKey> = {
  H25: "hike_25",
  C25: "cut_25",
  H0: "hold",
};

export const RATE_TO_DECISION: Record<FedRateKey, string> = {
  hike_25: "H25",
  cut_25: "C25",
  hold: "H0",
};

export const RATE_LABEL: Record<FedRateKey, string> = {
  hike_25: "25bp hike",
  cut_25: "25bp cut",
  hold: "no change",
};

export const DISSENT_LABEL: Record<FedDissentKey, string> = {
  zero: "0 dissents",
  some: ">0 dissents",
};

export function parseFedComboTicker(ticker: string): ParsedFedCombo | null {
  const t = ticker.trim().toUpperCase();
  const m = t.match(/^KXFEDCOMBO-(\d{2}[A-Z]{3})[A-Z]*-(\d+H|\d+C|0)-(T0|0)$/);
  if (!m) return null;
  const rate = RATE_FROM_COMBO[m[2]!];
  if (!rate) return null;
  return {
    ticker: t,
    period: m[1]!,
    rate,
    dissent: m[3] === "0" ? "zero" : "some",
  };
}

export function parseDecisionTicker(ticker: string): ParsedDecision | null {
  const t = ticker.trim().toUpperCase();
  const m = t.match(/^KXFEDDECISION-(\d{2}[A-Z]{3})-(H25|H0|C25)$/);
  if (!m) return null;
  const rate = RATE_FROM_DECISION[m[2]!];
  if (!rate) return null;
  return { ticker: t, period: m[1]!, rate };
}

export function parseDissentCountTicker(ticker: string): ParsedDissentCount | null {
  const t = ticker.trim().toUpperCase();
  const m = t.match(/^KXFOMCDISSENTCOUNT-(\d{2}[A-Z]{3})-(\d+)$/);
  if (!m) return null;
  return { ticker: t, period: m[1]!, count: Number(m[2]) };
}

export function extractPeriod(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  const m = t.match(/-(\d{2}[A-Z]{3})/);
  return m ? m[1]! : null;
}

export interface TwoLegScore {
  p: number;
  q: number;
  joint: number | null;
  independence: number;
  frechet_low: number;
  frechet_high: number;
  gap_vs_independence: number | null;
  phi: number | null;
  implied_rho: number | null;
  copula_fair: number | null;
  gap_vs_copula: number | null;
  flags: string[];
}

/**
 * Score a two-leg YES parlay.
 * `joint` is the listed combo mid when there is a book; omit for homemade parlays.
 * `rhoProxy` is an external correlation (e.g. overlapping daily log-return Pearson).
 */
export function scoreTwoLegParlay(input: {
  p: number;
  q: number;
  joint?: number | null;
  rhoProxy?: number | null;
  comboSpread?: number | null;
  legSpreads?: Array<number | null>;
}): TwoLegScore {
  const p = clampProb(input.p, 0, 1);
  const q = clampProb(input.q, 0, 1);
  const independence = p * q;
  const frechet_low = frechetLower([p, q]);
  const frechet_high = frechetUpper([p, q]);
  const joint = input.joint != null && Number.isFinite(input.joint) ? input.joint : null;
  const flags: string[] = [];

  const comboSpread = input.comboSpread;
  const legSpread = (input.legSpreads ?? []).reduce<number>((acc, s) => {
    if (s == null || !Number.isFinite(s)) return acc;
    return acc + s / 2;
  }, 0);
  const noise = Math.max(
    0.02,
    (comboSpread != null && Number.isFinite(comboSpread) ? comboSpread / 2 : 0) + legSpread,
  );

  let gap_vs_independence: number | null = null;
  let phi: number | null = null;
  let implied_rho: number | null = null;
  if (joint != null) {
    gap_vs_independence = joint - independence;
    phi = bernoulliPhi(p, q, joint);
    implied_rho = impliedGaussianRho(p, q, joint);
    if (joint > frechet_high + noise) flags.push("above_frechet");
    if (joint < frechet_low - noise) flags.push("below_frechet");
    if (Math.abs(gap_vs_independence) > noise) flags.push("independence_gap");
  }

  let copula_fair: number | null = null;
  let gap_vs_copula: number | null = null;
  if (input.rhoProxy != null && Number.isFinite(input.rhoProxy)) {
    copula_fair = gaussianCopulaJoint(p, q, input.rhoProxy);
    if (joint != null) {
      gap_vs_copula = joint - copula_fair;
      if (Math.abs(gap_vs_copula) > noise) flags.push("copula_gap");
    }
  }

  return {
    p,
    q,
    joint,
    independence: round6(independence),
    frechet_low: round6(frechet_low),
    frechet_high: round6(frechet_high),
    gap_vs_independence: gap_vs_independence == null ? null : round6(gap_vs_independence),
    phi: phi == null ? null : round6(phi),
    implied_rho: implied_rho == null ? null : round6(implied_rho),
    copula_fair: copula_fair == null ? null : round6(copula_fair),
    gap_vs_copula: gap_vs_copula == null ? null : round6(gap_vs_copula),
    flags,
  };
}

export function syntheticComplementQuote(
  zeroQuote: KalshiQuote,
  period: string,
): KalshiQuote {
  const p0 = quoteMid(zeroQuote);
  const pSome = p0 == null ? null : clampProb(1 - p0, 0, 1);
  const bid = zeroQuote.yes_ask != null ? clampProb(1 - zeroQuote.yes_ask, 0, 1) : null;
  const ask = zeroQuote.yes_bid != null ? clampProb(1 - zeroQuote.yes_bid, 0, 1) : null;
  return {
    series_ticker: zeroQuote.series_ticker,
    ticker: `KXFOMCDISSENTCOUNT-${period}-GT0`,
    event_ticker: zeroQuote.event_ticker,
    title: `Dissents > 0 (${period})`,
    yes_subtitle: ">0 (complement of 0)",
    yes_bid: bid,
    yes_ask: ask,
    yes_last: pSome,
    volume: zeroQuote.volume,
    close_time: zeroQuote.close_time,
    status: zeroQuote.status,
  };
}

export function alignedReturnPair(
  seriesA: Array<{ date: string; close: number }>,
  seriesB: Array<{ date: string; close: number }>,
): { a: number[]; b: number[]; n: number } | null {
  const mapB = new Map(seriesB.map((r) => [r.date, r.close]));
  const dates: string[] = [];
  const closesA: number[] = [];
  const closesB: number[] = [];
  for (const row of seriesA) {
    const other = mapB.get(row.date);
    if (other == null || !(row.close > 0) || !(other > 0)) continue;
    dates.push(row.date);
    closesA.push(row.close);
    closesB.push(other);
  }
  if (closesA.length < 10) return null;
  const a = logReturns(closesA);
  const b = logReturns(closesB);
  const n = Math.min(a.length, b.length);
  return { a: a.slice(0, n), b: b.slice(0, n), n };
}
