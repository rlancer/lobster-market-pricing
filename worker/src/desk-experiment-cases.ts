/**
 * Frozen as-of cases for the desk-approaches experiment.
 *
 * Invented tickers so models cannot recall a real name. The full series is one
 * authored path: the snapshot is clipped at as_of, and the next 5d/20d closes
 * continue that same tape. There is no hidden sequel after as-of.
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

type VolumeHint = "distribution" | "breakout" | "quiet" | "grind";

interface CaseSpec {
  id: string;
  ticker: string;
  name: string;
  sector: string;
  wick_sigma: number;
  volume: VolumeHint;
  /**
   * Skeleton closes at session indices. Must pin 0, as_of, as_of+5, as_of+20
   * (last session). Held-out closes continue the same path as the visible tape.
   */
  waypoints: Array<{ i: number; close: number }>;
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

const AS_OF = DESK_EXPERIMENT_AS_OF_INDEX;

const CASE_SPECS: CaseSpec[] = [
  {
    id: "drift-breakdown",
    ticker: "DRIFT",
    name: "Drift Payments",
    sector: "Financials",
    wick_sigma: 0.28,
    volume: "distribution",
    waypoints: [
      { i: 0, close: 68 },
      { i: 25, close: 70 },
      { i: 45, close: 64 },
      { i: 48, close: 62 },
      { i: 60, close: 58 },
      { i: 64, close: 56 },
      { i: 68, close: 54.8 },
      { i: AS_OF, close: 54 },
      { i: AS_OF + 5, close: 47.5 },
      { i: AS_OF + 20, close: 44.3 },
    ],
    news: [
      { days_before: 1, title: "Payments volume growth slows for a third month" },
      { days_before: 4, title: "Chargeback ratio ticks up; CFO cites 'noisy mix'" },
      { days_before: 9, title: "Two sell-side desks cut PT after merchant concentration note" },
    ],
    earnings_offset: 18,
    research_extra: [
      "Short interest elevated vs 90d; days-to-cover 4.8.",
      "Last month of tape is already lower highs / lower lows — not a one-day dip.",
    ],
    prompt:
      "As of the snapshot date, DRIFT has already rolled over. What is the tradable lean for the next 5 and 20 sessions? Direction only — do not invent prints after as-of.",
    notes: "Breakdown is in the as-of OHLC. Held-out 5d/20d continue that fade.",
    what_happened: "Kept selling: as-of close 54 → 47.5 in five sessions, 44.3 by day 20.",
  },
  {
    id: "bolt-coil",
    ticker: "BOLT",
    name: "Bolt Robotics",
    sector: "Technology",
    wick_sigma: 0.2,
    volume: "breakout",
    waypoints: [
      { i: 0, close: 39 },
      { i: 20, close: 40.5 },
      { i: 45, close: 41.2 },
      { i: 55, close: 40.9 },
      { i: 63, close: 41.1 },
      { i: 66, close: 41 },
      { i: 67, close: 41.9 },
      { i: 68, close: 42.8 },
      { i: AS_OF, close: 44 },
      { i: AS_OF + 5, close: 48.8 },
      { i: AS_OF + 20, close: 51 },
    ],
    news: [
      { days_before: 2, title: "FINRA short interest prints a 18-month high" },
      { days_before: 5, title: "Warehouse utilization cited as 'tight' on the earnings call replay" },
      { days_before: 11, title: "Quiet period: no new product news, range compressed for weeks" },
    ],
    earnings_offset: 22,
    research_extra: [
      "Multi-week range lived near 41. The last three sessions closed through that ceiling on rising volume.",
      "Borrow is special; short interest ~19% of float.",
    ],
    prompt:
      "As of the snapshot date, BOLT has already closed through the coil. What is the 5-session and 20-session lean — follow-through or fail?",
    notes: "Breakout is on the as-of bar. Held-out 5d/20d are follow-through, not a surprise squeeze.",
    what_happened: "Followed through: 44 → 48.8 in five sessions, 51 by day 20.",
  },
  {
    id: "cove-event",
    ticker: "COVE",
    name: "Cove Retail",
    sector: "Consumer",
    wick_sigma: 0.16,
    volume: "quiet",
    waypoints: [
      { i: 0, close: 58 },
      { i: 20, close: 57.4 },
      { i: 40, close: 58.6 },
      { i: 50, close: 57.8 },
      { i: 60, close: 58.3 },
      { i: 66, close: 58.1 },
      { i: 67, close: 58 },
      { i: 68, close: 57.9 },
      { i: AS_OF, close: 58 },
      { i: AS_OF + 5, close: 58.2 },
      { i: AS_OF + 20, close: 57.5 },
    ],
    news: [
      { days_before: 3, title: "COVE prints in-line EPS; implied move expired, spot unchanged" },
      { days_before: 4, title: "Same-store sales preview had been in-line traffic, mix mixed" },
      { days_before: 8, title: "Peer print a week earlier was a nothing-burger; COVE IV was the story" },
    ],
    earnings_offset: -3,
    research_extra: [
      "The print is already out. Spot has not left the three-week box.",
      "Leftover IV is not a spot directional tell.",
    ],
    prompt:
      "As of the snapshot date, COVE already reported in-line. What is the 5-session and 20-session directional lean in spot — not the IV trade?",
    notes: "Event is behind the as-of date. Spot is dead in the box; held-out stays inside the deadband.",
    what_happened: "Spot stayed in the box (58 → 58.2 in five sessions, 57.5 by day 20).",
  },
  {
    id: "dune-duration",
    ticker: "DUNE",
    name: "Dune Treasury Duration ETF",
    sector: "Rates",
    wick_sigma: 0.1,
    volume: "grind",
    waypoints: [
      { i: 0, close: 96 },
      { i: 20, close: 94 },
      { i: 40, close: 92 },
      { i: 48, close: 91 },
      { i: 60, close: 88.5 },
      { i: 64, close: 87.2 },
      { i: AS_OF, close: 85.5 },
      { i: AS_OF + 5, close: 82.1 },
      { i: AS_OF + 20, close: 77.8 },
    ],
    news: [
      { days_before: 0, title: "10y yield +18bp over 10 sessions; curve bear-steepens" },
      { days_before: 3, title: "Auction tails; duration ETFs see a second week of outflows" },
      { days_before: 7, title: "Street trims odds of a cut at the next meeting" },
    ],
    earnings_offset: null,
    research_extra: [
      "Duration sleeve, not a single issuer. Treat as rates beta.",
      "NAV has already been grinding lower with yields — this is not a one-day dip.",
    ],
    prompt:
      "As of the snapshot date, DUNE (long-duration Treasury ETF) is already marking down with yields. What is the tradable lean for the next 5 and 20 sessions?",
    notes: "The duration fade is in the as-of OHLC. Held-out 5d/20d continue that grind.",
    what_happened: "Yields kept rising; NAV continued lower (85.5 → 82.1 / 77.8).",
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

function closesFromWaypoints(
  n: number,
  waypoints: Array<{ i: number; close: number }>,
  rng: () => number,
  noiseFrac: number,
): number[] {
  const sorted = [...waypoints].sort((a, b) => a.i - b.i);
  if (sorted[0]?.i !== 0 || sorted.at(-1)?.i !== n - 1) {
    throw new Error("waypoints must pin session 0 and the last session");
  }
  const pinned = new Map(sorted.map((row) => [row.i, row.close]));
  const out = new Array<number>(n);
  for (let s = 0; s < sorted.length - 1; s++) {
    const a = sorted[s]!;
    const b = sorted[s + 1]!;
    const span = b.i - a.i;
    for (let i = a.i; i <= b.i; i++) {
      const t = span === 0 ? 0 : (i - a.i) / span;
      let px = a.close + (b.close - a.close) * t;
      if (!pinned.has(i) && noiseFrac > 0) {
        px *= 1 + (rng() - 0.5) * 2 * noiseFrac;
      }
      out[i] = round2(Math.max(0.01, px));
    }
  }
  for (const [i, close] of pinned) {
    out[i] = round2(close);
  }
  return out;
}

function volumeBoostAt(hint: VolumeHint, index: number, asOf: number, down: boolean): boolean {
  if (hint === "distribution") return index >= asOf - 10 && down;
  if (hint === "breakout") return index >= asOf - 2;
  if (hint === "grind") return index >= asOf - 15 && down;
  return false;
}

function buildBars(spec: CaseSpec, dates: string[], rng: () => number): DeskBar[] {
  const closes = closesFromWaypoints(dates.length, spec.waypoints, rng, 0.004);
  const bars: DeskBar[] = [];
  for (let i = 0; i < dates.length; i++) {
    const close = closes[i]!;
    const open = i === 0 ? close : bars[i - 1]!.close;
    bars.push(barAt(
      dates[i]!,
      open,
      close,
      spec.wick_sigma,
      rng,
      volumeBoostAt(spec.volume, i, AS_OF, close < open),
    ));
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

/** Visible-tape stats from a clipped as-of OHLC series. */
export function snapshotTapeStats(bars: DeskBar[]): {
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
    const label = snapshot.earnings_date > snapshot.as_of
      ? "earnings (scheduled)"
      : "earnings (already printed)";
    lines.push("", `=== ${label} ===`, snapshot.earnings_date);
  }
  return lines.join("\n");
}

function researchSummary(spec: CaseSpec, stats: ReturnType<typeof snapshotTapeStats>, asOf: string): string {
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
  const stats = snapshotTapeStats(clipped);
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
