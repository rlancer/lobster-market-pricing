/**
 * Frozen as-of cases for the desk-approaches experiment.
 *
 * Invented tickers + a seeded tape so models cannot recall a real outcome.
 * Each case keeps a full series; the snapshot is clipped to as_of, and the
 * 5d/20d closes after that date are the held-out grade.
 */

export const DESK_EXPERIMENT_SEED = 0x4d45534b; // 'DESK'
export const DESK_EXPERIMENT_START_DATE = "2026-01-05";
export const DESK_EXPERIMENT_TRADING_DAYS = 90;
/** 0-based index of the as-of bar (70th session). Forward 5d/20d are held out. */
export const DESK_EXPERIMENT_AS_OF_INDEX = 69;

export type DeskLean = "bullish" | "bearish" | "neutral";

export interface DeskBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DeskOptionQuote {
  expiration: string;
  type: "call" | "put";
  strike: number;
  bid: number;
  ask: number;
  volume: number;
  open_interest: number;
  implied_vol: number;
}

export interface DeskNewsItem {
  date: string;
  title: string;
}

export interface DeskExperimentSnapshot {
  as_of: string;
  ticker: string;
  name: string;
  sector: string;
  research_summary: string;
  ohlc: DeskBar[];
  options: DeskOptionQuote[];
  news: DeskNewsItem[];
  earnings_date: string | null;
}

export interface DeskExperimentOutcome {
  close_as_of: number;
  close_5d: number;
  close_20d: number;
  return_5d_pct: number;
  return_20d_pct: number;
  what_happened: string;
}

export interface DeskExperimentCase {
  id: string;
  prompt: string;
  notes: string;
  snapshot: DeskExperimentSnapshot;
  outcome: DeskExperimentOutcome;
}

interface CaseSpec {
  id: string;
  ticker: string;
  name: string;
  sector: string;
  start: number;
  mu: number;
  sigma: number;
  /** Held-out simple returns from the as-of close (not shown to the model). */
  return_5d: number;
  return_20d: number;
  news: Array<{ days_before: number; title: string }>;
  earnings_offset: number | null;
  research_extra: string[];
  prompt: string;
  notes: string;
  what_happened: string;
}

function createRng(seed: number): () => number {
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
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

function shiftTradingDate(dates: string[], index: number, offset: number): string | null {
  const next = index + offset;
  if (next < 0 || next >= dates.length) return null;
  return dates[next] ?? null;
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function fmtPct(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

const CASE_SPECS: CaseSpec[] = [
  {
    id: "drift-breakdown",
    ticker: "DRIFT",
    name: "Drift Payments",
    sector: "Financials",
    start: 64,
    mu: -0.08,
    sigma: 0.32,
    return_5d: -0.12,
    return_20d: -0.18,
    news: [
      { days_before: 1, title: "Payments volume growth slows for a third month" },
      { days_before: 4, title: "Chargeback ratio ticks up; CFO cites 'noisy mix'" },
      { days_before: 9, title: "Two sell-side desks cut PT after merchant concentration note" },
    ],
    earnings_offset: 18,
    research_extra: [
      "Short interest elevated vs 90d; days-to-cover 4.8.",
      "Management commentary on the last print stressed 'stabilizing', not accelerating.",
    ],
    prompt:
      "As of the snapshot date, what is the tradable lean in DRIFT for the next 5 and 20 sessions? Direction only — do not invent prints after as-of.",
    notes: "Weakening tape into as-of; a sharp post-as-of gap lower is held out.",
    what_happened: "Sold off hard over the next four sessions, then leaked lower through day 20.",
  },
  {
    id: "bolt-coil",
    ticker: "BOLT",
    name: "Bolt Robotics",
    sector: "Technology",
    start: 41,
    mu: 0.06,
    sigma: 0.22,
    return_5d: 0.11,
    return_20d: 0.16,
    news: [
      { days_before: 2, title: "FINRA short interest prints a 18-month high" },
      { days_before: 5, title: "Warehouse utilization cited as 'tight' on the earnings call replay" },
      { days_before: 11, title: "Quiet period: no new product news, range continues to compress" },
    ],
    earnings_offset: 22,
    research_extra: [
      "20-session range is tight; volume drying vs 20d average.",
      "Borrow is special; short interest ~19% of float.",
    ],
    prompt:
      "As of the snapshot date, what is the tradable lean in BOLT for the next 5 and 20 sessions? Coil vs breakdown — pick a side.",
    notes: "Compression + elevated short interest into as-of; the squeeze/rally is held out.",
    what_happened: "Broke up on expanding volume two sessions later and held the higher range.",
  },
  {
    id: "cove-event",
    ticker: "COVE",
    name: "Cove Retail",
    sector: "Consumer",
    start: 58,
    mu: 0.04,
    sigma: 0.18,
    return_5d: 0.004,
    return_20d: -0.06,
    news: [
      { days_before: 1, title: "Street sits 2c wide on EPS; implied move ~7%" },
      { days_before: 3, title: "Same-store sales preview: in-line traffic, mix mixed" },
      { days_before: 8, title: "Peer print overnight was a nothing-burger; IV still bid in COVE" },
    ],
    earnings_offset: 1,
    research_extra: [
      "Front-week ATM IV is rich vs 30d realized.",
      "Spot has gone nowhere for three weeks; the event is the whole tape.",
    ],
    prompt:
      "As of the snapshot date, COVE reports after the next session. What is the 5-session and 20-session directional lean — not the IV trade?",
    notes: "Rich IV into a scheduled print; spot goes nowhere in 5d and drifts down in 20d (held out).",
    what_happened: "Print was in-line; spot chopped, then leaked over the following three weeks.",
  },
  {
    id: "dune-duration",
    ticker: "DUNE",
    name: "Dune Treasury Duration ETF",
    sector: "Rates",
    start: 92,
    mu: -0.04,
    sigma: 0.12,
    return_5d: -0.04,
    return_20d: -0.09,
    news: [
      { days_before: 0, title: "10y yield +18bp over 10 sessions; curve bear-steepens" },
      { days_before: 3, title: "Auction tails; duration ETFs see a second week of outflows" },
      { days_before: 7, title: "Street trims odds of a cut at the next meeting" },
    ],
    earnings_offset: null,
    research_extra: [
      "Duration sleeve, not a single issuer. Treat as rates beta.",
      "Realized vol is low; the move is in yields, not in an earnings print.",
    ],
    prompt:
      "As of the snapshot date, what is the tradable lean in DUNE (long-duration Treasury ETF) for the next 5 and 20 sessions?",
    notes: "Yields already rising into as-of; further price erosion after as-of is held out.",
    what_happened: "Yields kept rising; NAV grinded lower through both horizons.",
  },
];

function barAt(
  date: string,
  open: number,
  close: number,
  sigma: number,
  rng: () => number,
  volumeBoost: boolean,
): DeskBar {
  const wick = Math.abs(boxMuller(rng)) * sigma * Math.max(open, close) * 0.015;
  const volume = Math.round(400_000 + rng() * 1_800_000 + (volumeBoost ? 900_000 : 0));
  return {
    date,
    open: round2(open),
    high: round2(Math.max(open, close) + wick),
    low: round2(Math.max(0.01, Math.min(open, close) - wick)),
    close: round2(Math.max(0.01, close)),
    volume,
  };
}

function buildBars(spec: CaseSpec, dates: string[], rng: () => number): DeskBar[] {
  const dt = 1 / 252;
  const asOf = DESK_EXPERIMENT_AS_OF_INDEX;
  const bars: DeskBar[] = [];
  let price = spec.start;
  for (let i = 0; i <= asOf; i++) {
    const shock = boxMuller(rng);
    const ret = (spec.mu - 0.5 * spec.sigma * spec.sigma) * dt + spec.sigma * Math.sqrt(dt) * shock;
    const open = price;
    const close = price * Math.exp(ret);
    bars.push(barAt(dates[i]!, open, close, spec.sigma, rng, i >= asOf - 3));
    price = close;
  }

  const p0 = bars[asOf]!.close;
  const p5 = p0 * (1 + spec.return_5d);
  const p20 = p0 * (1 + spec.return_20d);
  for (let i = asOf + 1; i < dates.length; i++) {
    const offset = i - asOf;
    const target = offset <= 5
      ? p0 + (p5 - p0) * (offset / 5)
      : p5 + (p20 - p5) * ((offset - 5) / 15);
    const open = bars[i - 1]!.close;
    bars.push(barAt(dates[i]!, open, target, spec.sigma, rng, offset <= 5));
  }
  return bars;
}

function buildOptions(spot: number, dates: string[], asOfIndex: number, rng: () => number): DeskOptionQuote[] {
  const expiration = shiftTradingDate(dates, asOfIndex, 21) ?? dates[dates.length - 1]!;
  const atm = Math.round(spot);
  const strikes = [atm - 5, atm - 2, atm, atm + 2, atm + 5].filter((s) => s > 0);
  const out: DeskOptionQuote[] = [];
  for (const strike of strikes) {
    for (const type of ["call", "put"] as const) {
      const moneyness = type === "call" ? strike / spot - 1 : 1 - strike / spot;
      const iv = round4(0.32 + Math.abs(moneyness) * 0.4 + (rng() - 0.5) * 0.04);
      const mid = Math.max(0.15, Math.abs(spot - strike) * 0.08 + spot * iv * 0.12);
      const spread = Math.max(0.05, mid * 0.06);
      out.push({
        expiration,
        type,
        strike,
        bid: round2(Math.max(0.05, mid - spread / 2)),
        ask: round2(mid + spread / 2),
        volume: Math.round(200 + rng() * 2_400),
        open_interest: Math.round(800 + rng() * 6_000),
        implied_vol: iv,
      });
    }
  }
  return out;
}

function analyze(bars: DeskBar[]): {
  spot: number;
  change_1d_pct: number;
  change_5d_pct: number;
  change_21d_pct: number;
  trend: "up" | "down" | "sideways";
  consolidation: boolean;
  accumulation: "accumulating" | "distributing" | "neutral";
  volume_rel: number;
} {
  const n = bars.length;
  const spot = bars[n - 1]!.close;
  const closeAt = (offset: number) => bars[Math.max(0, n - 1 - offset)]!.close;
  const change_1d_pct = pctChange(closeAt(1), spot);
  const change_5d_pct = pctChange(closeAt(5), spot);
  const change_21d_pct = pctChange(closeAt(Math.min(21, n - 1)), spot);
  const window = bars.slice(-20);
  const highs = window.map((b) => b.high);
  const lows = window.map((b) => b.low);
  const rangePct = ((Math.max(...highs) - Math.min(...lows)) / spot) * 100;
  const consolidation = rangePct < 8;
  const trend = change_21d_pct > 4 ? "up" : change_21d_pct < -4 ? "down" : "sideways";
  const vol20 = window.reduce((s, b) => s + b.volume, 0) / window.length;
  const volume_rel = bars[n - 1]!.volume / vol20;
  const accumulation = volume_rel > 1.2 && change_5d_pct > 0
    ? "accumulating"
    : volume_rel > 1.2 && change_5d_pct < 0
      ? "distributing"
      : "neutral";
  return {
    spot,
    change_1d_pct,
    change_5d_pct,
    change_21d_pct,
    trend,
    consolidation,
    accumulation,
    volume_rel,
  };
}

function formatOhlcCsv(bars: DeskBar[]): string {
  const tail = bars.slice(-30);
  const lines = ["date,open,high,low,close,volume"];
  for (const bar of tail) {
    lines.push(`${bar.date},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
  }
  return lines.join("\n");
}

function formatOptionsCsv(rows: DeskOptionQuote[]): string {
  const lines = ["expiration,type,strike,bid,ask,volume,open_interest,implied_vol"];
  for (const row of rows) {
    lines.push(
      `${row.expiration},${row.type},${row.strike},${row.bid},${row.ask},${row.volume},${row.open_interest},${row.implied_vol}`,
    );
  }
  return lines.join("\n");
}

export function formatDeskSnapshot(snapshot: DeskExperimentSnapshot): string {
  const lines = [
    `AS OF ${snapshot.as_of}. Treat this date as today. Do not use or invent facts after it.`,
    "",
    "=== research_ticker ===",
    snapshot.research_summary,
    "",
    "=== ohlc (sessions on or before as_of) ===",
    formatOhlcCsv(snapshot.ohlc),
    "",
    "=== option_contracts (as_of snapshot) ===",
    formatOptionsCsv(snapshot.options),
    "",
    "=== news (dated on or before as_of) ===",
  ];
  for (const item of snapshot.news) {
    lines.push(`- ${item.date} — ${item.title}`);
  }
  if (snapshot.earnings_date) {
    lines.push("", `=== earnings (scheduled) ===`, snapshot.earnings_date);
  }
  return lines.join("\n");
}

function researchSummary(spec: CaseSpec, stats: ReturnType<typeof analyze>, asOf: string): string {
  const lines = [
    `${spec.ticker} — ${spec.name} (${spec.sector})`,
    `Spot ${stats.spot.toFixed(2)}, 1d ${fmtPct(stats.change_1d_pct)}, 5d ${fmtPct(stats.change_5d_pct)}, 21d ${fmtPct(stats.change_21d_pct)}`,
    `Volume vs 20d avg: ${(stats.volume_rel * 100).toFixed(0)}%`,
    `Technicals: trend=${stats.trend}, consolidation=${stats.consolidation}, accumulation=${stats.accumulation}`,
    ...spec.research_extra.map((line) => `- ${line}`),
    `Research fresh @ ${asOf}T21:00:00.000Z (as-of snapshot; not live)`,
  ];
  return lines.join("\n");
}

function buildCase(spec: CaseSpec, dates: string[], seed: number): DeskExperimentCase {
  const rng = createRng(seed);
  const bars = buildBars(spec, dates, rng);
  const asOfIndex = DESK_EXPERIMENT_AS_OF_INDEX;
  const asOf = dates[asOfIndex]!;
  const clipped = bars.slice(0, asOfIndex + 1);
  const stats = analyze(clipped);
  const options = buildOptions(stats.spot, dates, asOfIndex, rng);
  const news: DeskNewsItem[] = spec.news.map((item) => ({
    date: shiftTradingDate(dates, asOfIndex, -item.days_before) ?? asOf,
    title: item.title,
  }));
  const earnings_date = spec.earnings_offset == null
    ? null
    : shiftTradingDate(dates, asOfIndex, spec.earnings_offset);

  const closeAsOf = bars[asOfIndex]!.close;
  const close5 = bars[asOfIndex + 5]!.close;
  const close20 = bars[asOfIndex + 20]!.close;

  const snapshot: DeskExperimentSnapshot = {
    as_of: asOf,
    ticker: spec.ticker,
    name: spec.name,
    sector: spec.sector,
    research_summary: researchSummary(spec, stats, asOf),
    ohlc: clipped,
    options,
    news,
    earnings_date,
  };

  return {
    id: spec.id,
    prompt: spec.prompt,
    notes: spec.notes,
    snapshot,
    outcome: {
      close_as_of: closeAsOf,
      close_5d: close5,
      close_20d: close20,
      return_5d_pct: round2(pctChange(closeAsOf, close5)),
      return_20d_pct: round2(pctChange(closeAsOf, close20)),
      what_happened: spec.what_happened,
    },
  };
}

export function buildDeskExperimentCases(seed = DESK_EXPERIMENT_SEED): DeskExperimentCase[] {
  const dates = tradingDates(DESK_EXPERIMENT_START_DATE, DESK_EXPERIMENT_TRADING_DAYS);
  return CASE_SPECS.map((spec, index) =>
    buildCase(spec, dates, seed + (index + 1) * 0x9e3779b9),
  );
}

/**
 * Price/news in the snapshot must be on or before as_of. Future earnings
 * dates and option expirations are allowed — those were knowable that day.
 */
export function snapshotAsOfViolations(snapshot: DeskExperimentSnapshot): string[] {
  const asOf = snapshot.as_of;
  const violations: string[] = [];
  if (snapshot.ohlc.some((bar) => bar.date > asOf)) {
    violations.push("ohlc contains bars after as_of");
  }
  if (snapshot.news.some((item) => item.date > asOf)) {
    violations.push("news dated after as_of");
  }
  if (snapshot.options.some((row) => row.expiration < asOf)) {
    violations.push("option expiration before as_of");
  }
  const allowedFuture = new Set<string>();
  if (snapshot.earnings_date && snapshot.earnings_date > asOf) {
    allowedFuture.add(snapshot.earnings_date);
  }
  for (const row of snapshot.options) {
    if (row.expiration > asOf) allowedFuture.add(row.expiration);
  }
  const text = formatDeskSnapshot(snapshot);
  const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? [];
  for (const date of iso) {
    if (date > asOf && !allowedFuture.has(date)) {
      violations.push(`snapshot text mentions ${date} after as_of`);
    }
  }
  return [...new Set(violations)];
}
