/**
 * Deterministic synthetic equity panel for notebook experiments.
 * Seeded PRNG + geometric Brownian motion with planted crashes/rallies so
 * graded questions have stable, computable ground truth.
 */

export const SYNTH_SEED = 0x1a2b3c4d;
export const SYNTH_TRADING_DAYS = 126; // ~6 months
export const SYNTH_START_DATE = '2025-01-02';

/** 20 fictional tickers — avoids leaking real-market priors into the model. */
export const SYNTH_TICKERS = [
  'AERO', 'BRIN', 'COVE', 'DRIFT', 'EMBER',
  'FLINT', 'GLADE', 'HAVEN', 'IVY', 'JADE',
  'KEEL', 'LUMEN', 'MIRTH', 'NORTH', 'ORBIT',
  'PRISM', 'QUILL', 'RIDGE', 'SPIRE', 'TRELL',
] as const;

export type SynthTicker = (typeof SYNTH_TICKERS)[number];

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerSeries {
  ticker: SynthTicker;
  name: string;
  sector: string;
  bars: DailyBar[];
}

export interface SynthUniverse {
  seed: number;
  startDate: string;
  tradingDays: number;
  series: TickerSeries[];
}

interface TickerSpec {
  ticker: SynthTicker;
  name: string;
  sector: string;
  start: number;
  /** Annualized drift. */
  mu: number;
  /** Annualized volatility. */
  sigma: number;
  crashDay?: number;
  crashPct?: number;
  rallyDay?: number;
  rallyPct?: number;
}

const SPECS: TickerSpec[] = [
  { ticker: 'AERO', name: 'Aero Dynamics', sector: 'Industrials', start: 42, mu: 0.18, sigma: 0.28 },
  { ticker: 'BRIN', name: 'Brin Softworks', sector: 'Technology', start: 88, mu: 0.55, sigma: 0.45, rallyDay: 90, rallyPct: 0.12 },
  { ticker: 'COVE', name: 'Cove Retail', sector: 'Consumer', start: 61, mu: 0.08, sigma: 0.22 },
  { ticker: 'DRIFT', name: 'Drift Payments', sector: 'Financials', start: 73, mu: -0.05, sigma: 0.35, crashDay: 55, crashPct: 0.22 },
  { ticker: 'EMBER', name: 'Ember Energy', sector: 'Energy', start: 34, mu: 0.12, sigma: 0.4 },
  { ticker: 'FLINT', name: 'Flint Robotics', sector: 'Technology', start: 51, mu: 0.32, sigma: 0.5 },
  { ticker: 'GLADE', name: 'Glade Foods', sector: 'Consumer', start: 29, mu: 0.06, sigma: 0.18 },
  { ticker: 'HAVEN', name: 'Haven Health', sector: 'Health Care', start: 97, mu: 0.14, sigma: 0.25 },
  { ticker: 'IVY', name: 'Ivy Semiconductors', sector: 'Technology', start: 112, mu: 0.4, sigma: 0.55 },
  { ticker: 'JADE', name: 'Jade Materials', sector: 'Materials', start: 46, mu: -0.12, sigma: 0.3, crashDay: 40, crashPct: 0.18 },
  { ticker: 'KEEL', name: 'Keel Shipping', sector: 'Industrials', start: 58, mu: 0.1, sigma: 0.27 },
  { ticker: 'LUMEN', name: 'Lumen Networks', sector: 'Communications', start: 39, mu: 0.22, sigma: 0.33 },
  { ticker: 'MIRTH', name: 'Mirth Media', sector: 'Communications', start: 27, mu: -0.2, sigma: 0.48, crashDay: 70, crashPct: 0.3 },
  { ticker: 'NORTH', name: 'North Utilities', sector: 'Utilities', start: 64, mu: 0.05, sigma: 0.14 },
  { ticker: 'ORBIT', name: 'Orbit Cloud', sector: 'Technology', start: 121, mu: 0.48, sigma: 0.42 },
  { ticker: 'PRISM', name: 'Prism Biotech', sector: 'Health Care', start: 76, mu: 0.25, sigma: 0.6 },
  { ticker: 'QUILL', name: 'Quill Publishing', sector: 'Consumer', start: 33, mu: 0.02, sigma: 0.2 },
  { ticker: 'RIDGE', name: 'Ridge Mining', sector: 'Materials', start: 48, mu: -0.08, sigma: 0.38 },
  { ticker: 'SPIRE', name: 'Spire Defense', sector: 'Industrials', start: 85, mu: 0.28, sigma: 0.31 },
  { ticker: 'TRELL', name: 'Trell Agriculture', sector: 'Consumer', start: 44, mu: 0.09, sigma: 0.19 },
];

/** Mulberry32 — small deterministic PRNG. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Skip weekends from an ISO date; returns YYYY-MM-DD trading calendar. */
export function tradingDates(startDate: string, count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildBars(spec: TickerSpec, dates: string[], rng: () => number): DailyBar[] {
  const dt = 1 / 252;
  const bars: DailyBar[] = [];
  let price = spec.start;
  for (let i = 0; i < dates.length; i++) {
    const shock = boxMuller(rng);
    const ret = (spec.mu - 0.5 * spec.sigma * spec.sigma) * dt + spec.sigma * Math.sqrt(dt) * shock;
    const open = price;
    let close = price * Math.exp(ret);
    if (spec.crashDay === i && spec.crashPct) close *= 1 - spec.crashPct;
    if (spec.rallyDay === i && spec.rallyPct) close *= 1 + spec.rallyPct;
    const wick = Math.abs(boxMuller(rng)) * spec.sigma * price * 0.02;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const volume = Math.round(500_000 + rng() * 2_500_000 + (spec.crashDay === i ? 4_000_000 : 0));
    bars.push({
      date: dates[i]!,
      open: round2(open),
      high: round2(high),
      low: round2(Math.max(0.01, low)),
      close: round2(Math.max(0.01, close)),
      volume,
    });
    price = close;
  }
  return bars;
}

export function buildSynthUniverse(seed = SYNTH_SEED): SynthUniverse {
  const dates = tradingDates(SYNTH_START_DATE, SYNTH_TRADING_DAYS);
  const series = SPECS.map((spec, index) => {
    const rng = createRng(seed + (index + 1) * 0x9e3779b9);
    return {
      ticker: spec.ticker,
      name: spec.name,
      sector: spec.sector,
      bars: buildBars(spec, dates, rng),
    } satisfies TickerSeries;
  });
  return {
    seed,
    startDate: SYNTH_START_DATE,
    tradingDays: SYNTH_TRADING_DAYS,
    series,
  };
}

export interface TickerStats {
  ticker: SynthTicker;
  name: string;
  sector: string;
  startClose: number;
  endClose: number;
  totalReturnPct: number;
  maxClose: number;
  maxCloseDate: string;
  minClose: number;
  minCloseDate: string;
  dailyReturnStdPct: number;
  crashDay: string | null;
}

export function tickerStats(series: TickerSeries): TickerStats {
  const closes = series.bars.map((b) => b.close);
  const startClose = closes[0]!;
  const endClose = closes[closes.length - 1]!;
  let maxClose = -Infinity;
  let minClose = Infinity;
  let maxCloseDate = series.bars[0]!.date;
  let minCloseDate = series.bars[0]!.date;
  const dailyReturns: number[] = [];

  for (let i = 0; i < series.bars.length; i++) {
    const bar = series.bars[i]!;
    if (bar.close > maxClose) {
      maxClose = bar.close;
      maxCloseDate = bar.date;
    }
    if (bar.close < minClose) {
      minClose = bar.close;
      minCloseDate = bar.date;
    }
    if (i > 0) dailyReturns.push(bar.close / series.bars[i - 1]!.close - 1);
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance);

  let crashDay: string | null = null;
  let worst = 0;
  for (let i = 1; i < series.bars.length; i++) {
    const dayRet = series.bars[i]!.close / series.bars[i - 1]!.close - 1;
    if (dayRet < worst) {
      worst = dayRet;
      if (dayRet <= -0.12) crashDay = series.bars[i]!.date;
    }
  }

  return {
    ticker: series.ticker,
    name: series.name,
    sector: series.sector,
    startClose,
    endClose,
    totalReturnPct: (endClose / startClose - 1) * 100,
    maxClose,
    maxCloseDate,
    minClose,
    minCloseDate,
    dailyReturnStdPct: std * 100,
    crashDay,
  };
}

export function universeStats(universe: SynthUniverse): TickerStats[] {
  return universe.series.map(tickerStats);
}
