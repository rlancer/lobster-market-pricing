/**
 * Live Kalshi parlay experiment: listed Fed combos vs independence of the
 * decision × dissent legs, plus homemade same-horizon parlays scored with a
 * Gaussian copula using lake return correlation.
 */

import {
  DISSENT_LABEL,
  KALSHI_PARLAY_DESIGN_ID,
  KALSHI_PARLAY_SLUG,
  RATE_LABEL,
  alignedReturnPair,
  extractPeriod,
  isTwoSided,
  parseDecisionTicker,
  parseDissentCountTicker,
  parseFedComboTicker,
  parseKalshiNumber,
  pearsonCorrelation,
  quoteMid,
  quoteSpread,
  scoreTwoLegParlay,
  syntheticComplementQuote,
  type FedDissentKey,
  type FedRateKey,
  type KalshiQuote,
  type TwoLegScore,
} from "./kalshi-parlay";

export { KALSHI_PARLAY_DESIGN_ID, KALSHI_PARLAY_SLUG };

export const KALSHI_PUBLIC_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiQuoteView {
  ticker: string;
  title: string;
  subtitle: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  mid: number | null;
  spread: number | null;
  volume: number | null;
  close_time: string | null;
  two_sided: boolean;
}

export interface ParlayLegView {
  role: string;
  quote: KalshiQuoteView;
  selected_prob: number | null;
}

export interface TwoLegRow {
  id: string;
  kind: "listed_combo" | "homemade";
  meeting: string | null;
  label: string;
  rate?: FedRateKey;
  dissent?: FedDissentKey;
  combo: KalshiQuoteView | null;
  legs: ParlayLegView[];
  score: TwoLegScore;
  rho_proxy: number | null;
  rho_proxy_source: string | null;
  notes: string;
}

export interface MarginalCheck {
  meeting: string;
  name: string;
  combo_implied: number | null;
  standalone: number | null;
  gap: number | null;
  flag: boolean;
}

export interface MveCensus {
  scanned: number;
  two_sided: number;
  empty_book: number;
  sample_titles: string[];
}

export interface ReturnCorr {
  symbol_a: string;
  symbol_b: string;
  n: number;
  pearson: number;
  lookback_days: number;
}

export interface KalshiParlayVerdict {
  headline: string;
  bullets: string[];
  listed_flagged: number;
  listed_scored: number;
  max_abs_independence_gap: number | null;
  max_abs_implied_rho: number | null;
  homemade_high_corr: number;
}

export interface KalshiParlaySnapshot {
  design_id: string;
  slug: string;
  fetched_at: string;
  listed: TwoLegRow[];
  homemade: TwoLegRow[];
  marginals: MarginalCheck[];
  correlations: ReturnCorr[];
  mve: MveCensus;
  verdict: KalshiParlayVerdict;
  errors: string[];
}

export interface OhlcBar {
  symbol: string;
  date: string;
  close: number;
}

export interface KalshiParlayDeps {
  fetchJson: (url: string) => Promise<unknown>;
  queryOhlc?: (symbols: string[], since: string) => Promise<OhlcBar[]>;
  now?: () => number;
  kalshiBase?: string;
}

const FED_SERIES = ["KXFEDCOMBO", "KXFEDDECISION", "KXFOMCDISSENTCOUNT"] as const;
const HOMEMADE_SERIES = ["KXINXY", "KXDJIA", "KXBTC", "KXETH", "KXWTI"] as const;

const HOMEMADE_PAIRS: Array<{
  id: string;
  seriesA: string;
  seriesB: string;
  symbolA: string;
  symbolB: string;
  label: string;
  preferSameClose: boolean;
}> = [
  {
    id: "btc-eth",
    seriesA: "KXBTC",
    seriesB: "KXETH",
    symbolA: "BTC-USD",
    symbolB: "ETH-USD",
    label: "BTC × ETH same-session buckets",
    preferSameClose: true,
  },
  {
    id: "spy-dia",
    seriesA: "KXINXY",
    seriesB: "KXDJIA",
    symbolA: "SPY",
    symbolB: "DIA",
    label: "S&P year-end × Dow year-end",
    preferSameClose: false,
  },
  {
    id: "wti-spy",
    seriesA: "KXWTI",
    seriesB: "KXINXY",
    symbolA: "CL=F",
    symbolB: "SPY",
    label: "WTI above-strike × S&P year-end",
    preferSameClose: false,
  },
];

const OHLC_SYMBOLS = ["SPY", "DIA", "BTC-USD", "ETH-USD", "CL=F"];
const OHLC_LOOKBACK_DAYS = 180;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strip(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function mapKalshiMarket(seriesId: string, raw: unknown): KalshiQuote | null {
  const m = asRecord(raw);
  if (!m) return null;
  const ticker = strip(m.ticker).toUpperCase();
  if (!ticker) return null;
  return {
    series_ticker: seriesId,
    ticker,
    event_ticker: strip(m.event_ticker).toUpperCase() || null,
    title: strip(m.title) || ticker,
    yes_subtitle: strip(m.yes_sub_title) || strip(m.subtitle) || null,
    yes_bid: parseKalshiNumber(m.yes_bid_dollars ?? m.yes_bid),
    yes_ask: parseKalshiNumber(m.yes_ask_dollars ?? m.yes_ask),
    yes_last: parseKalshiNumber(m.last_price_dollars ?? m.last_price),
    volume: parseKalshiNumber(m.volume_fp ?? m.volume),
    close_time: strip(m.close_time) || null,
    status: strip(m.status) || "unknown",
  };
}

export function isLiveQuote(q: KalshiQuote, nowMs: number): boolean {
  const status = q.status.toLowerCase();
  if (status === "closed" || status === "settled" || status === "finalized") return false;
  if (q.close_time) {
    const t = Date.parse(q.close_time);
    if (Number.isFinite(t) && t < nowMs) return false;
  }
  return true;
}

export function toQuoteView(q: KalshiQuote): KalshiQuoteView {
  return {
    ticker: q.ticker,
    title: q.title,
    subtitle: q.yes_subtitle,
    yes_bid: q.yes_bid,
    yes_ask: q.yes_ask,
    yes_last: q.yes_last,
    mid: quoteMid(q),
    spread: quoteSpread(q),
    volume: q.volume,
    close_time: q.close_time,
    two_sided: isTwoSided(q),
  };
}

async function fetchSeriesMarkets(
  seriesId: string,
  deps: KalshiParlayDeps,
  maxPages = 3,
): Promise<KalshiQuote[]> {
  const base = (deps.kalshiBase || KALSHI_PUBLIC_API_BASE).replace(/\/$/, "");
  const out: KalshiQuote[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    let url = `${base}/markets?series_ticker=${encodeURIComponent(seriesId)}&status=open&limit=200`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const payload = await deps.fetchJson(url);
    const rec = asRecord(payload);
    const markets = rec?.markets;
    if (!Array.isArray(markets)) break;
    for (const raw of markets) {
      const mapped = mapKalshiMarket(seriesId, raw);
      if (mapped) out.push(mapped);
    }
    cursor = strip(rec?.cursor);
    if (!cursor || markets.length === 0) break;
  }
  return out;
}

async function fetchMveCensus(deps: KalshiParlayDeps): Promise<MveCensus> {
  const base = (deps.kalshiBase || KALSHI_PUBLIC_API_BASE).replace(/\/$/, "");
  const payload = await deps.fetchJson(
    `${base}/markets?mve_filter=only&status=open&limit=200`,
  );
  const markets = asRecord(payload)?.markets;
  const empty: MveCensus = { scanned: 0, two_sided: 0, empty_book: 0, sample_titles: [] };
  if (!Array.isArray(markets)) return empty;
  let twoSided = 0;
  let emptyBook = 0;
  const titles: string[] = [];
  for (const raw of markets) {
    const mapped = mapKalshiMarket("MVE", raw);
    if (!mapped) continue;
    if (isTwoSided(mapped)) twoSided += 1;
    else emptyBook += 1;
    if (titles.length < 5 && mapped.title) titles.push(mapped.title.slice(0, 80));
  }
  return {
    scanned: twoSided + emptyBook,
    two_sided: twoSided,
    empty_book: emptyBook,
    sample_titles: titles,
  };
}

function pickZeroDissent(quotes: KalshiQuote[], period: string): KalshiQuote | null {
  for (const q of quotes) {
    const parsed = parseDissentCountTicker(q.ticker);
    if (parsed && parsed.period === period && parsed.count === 0) return q;
  }
  return null;
}

function pickDecision(quotes: KalshiQuote[], period: string, rate: FedRateKey): KalshiQuote | null {
  for (const q of quotes) {
    const parsed = parseDecisionTicker(q.ticker);
    if (parsed && parsed.period === period && parsed.rate === rate) return q;
  }
  return null;
}

function liquidScore(q: KalshiQuote): number {
  const mid = quoteMid(q);
  if (mid == null || mid <= 0.05 || mid >= 0.95) return -1;
  const spread = quoteSpread(q);
  if (spread == null || spread >= 0.15) return -1;
  if (!isTwoSided(q)) return -1;
  const vol = q.volume ?? 0;
  const atm = 1 - Math.abs(mid - 0.5) * 2;
  return vol * 10 + atm * 100 - spread * 200;
}

function closeMs(q: KalshiQuote): number | null {
  if (!q.close_time) return null;
  const t = Date.parse(q.close_time);
  return Number.isFinite(t) ? t : null;
}

function pickHomemadeLeg(
  quotes: KalshiQuote[],
  nowMs: number,
  closeHintMs?: number | null,
  preferSameClose = false,
): KalshiQuote | null {
  const live = quotes.filter((q) => isLiveQuote(q, nowMs) && liquidScore(q) >= 0);
  if (!live.length) return null;
  if (closeHintMs != null && preferSameClose) {
    const same = live.filter((q) => {
      const t = closeMs(q);
      return t != null && Math.abs(t - closeHintMs) <= 48 * 3600 * 1000;
    });
    if (same.length) {
      same.sort((a, b) => liquidScore(b) - liquidScore(a));
      return same[0] ?? null;
    }
  }
  live.sort((a, b) => liquidScore(b) - liquidScore(a));
  if (closeHintMs == null) return live[0] ?? null;
  const windowed = live.filter((q) => {
    const t = closeMs(q);
    return t != null && Math.abs(t - closeHintMs) <= 45 * 24 * 3600 * 1000;
  });
  const pool = windowed.length ? windowed : live;
  pool.sort((a, b) => liquidScore(b) - liquidScore(a));
  return pool[0] ?? null;
}

function corrFor(
  correlations: ReturnCorr[],
  a: string,
  b: string,
): ReturnCorr | null {
  return correlations.find((c) =>
    (c.symbol_a === a && c.symbol_b === b) || (c.symbol_a === b && c.symbol_b === a)
  ) ?? null;
}

function buildListedRows(
  combos: KalshiQuote[],
  decisions: KalshiQuote[],
  dissents: KalshiQuote[],
  nowMs: number,
): { rows: TwoLegRow[]; marginals: MarginalCheck[] } {
  const rows: TwoLegRow[] = [];
  const byMeeting = new Map<string, TwoLegRow[]>();
  for (const combo of combos) {
    if (!isLiveQuote(combo, nowMs)) continue;
    const parsed = parseFedComboTicker(combo.ticker);
    if (!parsed) continue;
    const decision = pickDecision(decisions, parsed.period, parsed.rate);
    const zero = pickZeroDissent(dissents, parsed.period);
    if (!decision || !zero) continue;
    const dissentLeg = parsed.dissent === "zero"
      ? zero
      : syntheticComplementQuote(zero, parsed.period);
    const p = quoteMid(decision);
    const q = quoteMid(dissentLeg);
    const joint = quoteMid(combo);
    if (p == null || q == null) continue;
    const score = scoreTwoLegParlay({
      p,
      q,
      joint,
      comboSpread: quoteSpread(combo),
      legSpreads: [quoteSpread(decision), quoteSpread(dissentLeg)],
    });
    const row: TwoLegRow = {
      id: combo.ticker,
      kind: "listed_combo",
      meeting: parsed.period,
      label: `${RATE_LABEL[parsed.rate]} AND ${DISSENT_LABEL[parsed.dissent]}`,
      rate: parsed.rate,
      dissent: parsed.dissent,
      combo: toQuoteView(combo),
      legs: [
        { role: `rate · ${RATE_LABEL[parsed.rate]}`, quote: toQuoteView(decision), selected_prob: p },
        { role: `dissent · ${DISSENT_LABEL[parsed.dissent]}`, quote: toQuoteView(dissentLeg), selected_prob: q },
      ],
      score,
      rho_proxy: null,
      rho_proxy_source: null,
      notes: joint == null
        ? "Combo has no usable mid."
        : score.flags.includes("independence_gap")
          ? "Listed combo disagrees with independence of the standalone legs."
          : "Listed combo is within spread of the independence product.",
    };
    rows.push(row);
    const bucket = byMeeting.get(parsed.period) ?? [];
    bucket.push(row);
    byMeeting.set(parsed.period, bucket);
  }

  const marginals: MarginalCheck[] = [];
  for (const [meeting, meetingRows] of byMeeting) {
    const add = (
      name: string,
      comboImplied: number | null,
      standalone: number | null,
    ) => {
      const gap = comboImplied != null && standalone != null ? comboImplied - standalone : null;
      marginals.push({
        meeting,
        name,
        combo_implied: comboImplied,
        standalone,
        gap,
        flag: gap != null && Math.abs(gap) > 0.03,
      });
    };

    const rateKeys: FedRateKey[] = ["hike_25", "hold", "cut_25"];
    for (const rate of rateKeys) {
      const cells = meetingRows.filter((r) => r.rate === rate);
      const comboImplied = sumMids(cells.map((r) => r.combo?.mid ?? null));
      const standalone = cells[0]?.legs[0]?.selected_prob ?? null;
      add(`P(${RATE_LABEL[rate]})`, comboImplied, standalone);
    }
    const dissentKeys: FedDissentKey[] = ["zero", "some"];
    for (const dissent of dissentKeys) {
      const cells = meetingRows.filter((r) => r.dissent === dissent);
      const comboImplied = sumMids(cells.map((r) => r.combo?.mid ?? null));
      const standalone = cells[0]?.legs[1]?.selected_prob ?? null;
      add(`P(${DISSENT_LABEL[dissent]})`, comboImplied, standalone);
    }
    add(
      "sum of combo cells",
      sumMids(meetingRows.map((r) => r.combo?.mid ?? null)),
      1,
    );
  }
  return { rows, marginals };
}

function sumMids(values: Array<number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n ? sum : null;
}

function buildHomemadeRows(
  bySeries: Map<string, KalshiQuote[]>,
  correlations: ReturnCorr[],
  nowMs: number,
): TwoLegRow[] {
  const rows: TwoLegRow[] = [];
  for (const pair of HOMEMADE_PAIRS) {
    const aPool = bySeries.get(pair.seriesA) ?? [];
    const bPool = bySeries.get(pair.seriesB) ?? [];
    const legA = pickHomemadeLeg(aPool, nowMs);
    if (!legA) continue;
    const legB = pickHomemadeLeg(bPool, nowMs, closeMs(legA), pair.preferSameClose);
    if (!legB) continue;
    const p = quoteMid(legA);
    const q = quoteMid(legB);
    if (p == null || q == null) continue;
    const corr = corrFor(correlations, pair.symbolA, pair.symbolB);
    const score = scoreTwoLegParlay({
      p,
      q,
      rhoProxy: corr?.pearson ?? null,
      legSpreads: [quoteSpread(legA), quoteSpread(legB)],
    });
    const closeNote = (() => {
      const ta = closeMs(legA);
      const tb = closeMs(legB);
      if (ta == null || tb == null) return "close times unknown";
      const hours = Math.abs(ta - tb) / 3600000;
      if (hours <= 48) return `closes ${hours.toFixed(0)}h apart`;
      return `closes ${(hours / 24).toFixed(0)}d apart`;
    })();
    rows.push({
      id: pair.id,
      kind: "homemade",
      meeting: extractPeriod(legA.ticker),
      label: pair.label,
      combo: null,
      legs: [
        { role: pair.symbolA, quote: toQuoteView(legA), selected_prob: p },
        { role: pair.symbolB, quote: toQuoteView(legB), selected_prob: q },
      ],
      score,
      rho_proxy: corr?.pearson ?? null,
      rho_proxy_source: corr
        ? `${corr.n} overlapping daily log returns (${corr.symbol_a} vs ${corr.symbol_b})`
        : null,
      notes: corr
        ? `No listed combo. Independence vs Gaussian copula using ${closeNote}.`
        : `No listed combo. ${closeNote}. Lake correlation unavailable.`,
    });
  }
  return rows;
}

export function buildCorrelations(
  bars: OhlcBar[],
  lookbackDays: number,
): ReturnCorr[] {
  const bySymbol = new Map<string, Array<{ date: string; close: number }>>();
  for (const bar of bars) {
    if (!bar.symbol || !bar.date || !(bar.close > 0)) continue;
    const list = bySymbol.get(bar.symbol) ?? [];
    list.push({ date: bar.date, close: bar.close });
    bySymbol.set(bar.symbol, list);
  }
  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }
  const pairs: Array<[string, string]> = [
    ["BTC-USD", "ETH-USD"],
    ["SPY", "DIA"],
    ["SPY", "CL=F"],
    ["SPY", "BTC-USD"],
  ];
  const out: ReturnCorr[] = [];
  for (const [a, b] of pairs) {
    const sa = bySymbol.get(a);
    const sb = bySymbol.get(b);
    if (!sa || !sb) continue;
    const aligned = alignedReturnPair(sa, sb);
    if (!aligned) continue;
    const pearson = pearsonCorrelation(aligned.a, aligned.b);
    if (pearson == null) continue;
    out.push({
      symbol_a: a,
      symbol_b: b,
      n: aligned.n,
      pearson,
      lookback_days: lookbackDays,
    });
  }
  return out;
}

export function buildVerdict(
  listed: TwoLegRow[],
  homemade: TwoLegRow[],
  marginals: MarginalCheck[],
  mve: MveCensus,
  correlations: ReturnCorr[],
): KalshiParlayVerdict {
  const scored = listed.filter((r) => r.score.joint != null);
  const flagged = scored.filter((r) => r.score.flags.includes("independence_gap"));
  const gaps = scored
    .map((r) => r.score.gap_vs_independence)
    .filter((g): g is number => g != null);
  const rhos = scored
    .map((r) => r.score.implied_rho)
    .filter((g): g is number => g != null);
  const maxGap = gaps.length ? Math.max(...gaps.map(Math.abs)) : null;
  const maxRho = rhos.length ? rhos.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b) : null;
  const homemadeHigh = homemade.filter((r) => r.rho_proxy != null && Math.abs(r.rho_proxy) >= 0.35).length;
  const highCorrPairs = correlations.filter((row) => Math.abs(row.pearson) >= 0.35);
  const marginalFlags = marginals.filter((m) => m.flag).length;
  const bullets: string[] = [];

  if (!scored.length) {
    bullets.push("No live KXFEDCOMBO cells with both legs quoted — cannot score listed parlays this pass.");
  } else if (flagged.length) {
    bullets.push(
      `${flagged.length} of ${scored.length} listed Fed combo cells disagree with independence by more than the quote noise floor.`,
    );
  } else {
    bullets.push(
      `All ${scored.length} listed Fed combo cells sit inside the bid/ask noise of the independence product.`,
    );
  }
  if (maxRho != null) {
    bullets.push(
      `Largest implied Gaussian (tetrachoric) ρ on a listed cell is ${maxRho.toFixed(2)} — the legs are not independent.`,
    );
  }
  if (marginalFlags) {
    bullets.push(
      `${marginalFlags} combo-implied marginals disagree with the standalone decision/dissent books by >3¢ — a second, cross-book kind of mispricing.`,
    );
  }
  if (mve.scanned) {
    bullets.push(
      `Public combo CLOB: ${mve.two_sided} of ${mve.scanned} scanned MVE markets have a two-sided book inside (0,1). Sports parlays are mostly RFQ, not a screenable tape.`,
    );
  }
  if (homemadeHigh) {
    bullets.push(
      `${homemadeHigh} homemade investing parlays sit on underlyings whose overlapping daily returns correlate |ρ|≥0.35, so an independence-priced parlay would be the wrong model even before fees.`,
    );
  } else if (highCorrPairs.length) {
    const names = highCorrPairs.map((row) => `${row.symbol_a}×${row.symbol_b} ${row.pearson.toFixed(2)}`).join(", ");
    bullets.push(
      `Lake return pairs still show correlation even when a combo book is missing: ${names}. Pricing those as independent parlays would be the wrong model.`,
    );
  } else if (correlations.length) {
    bullets.push("Lake return pairs were computed, but none of the homemade parlay underlyings cleared |ρ|≥0.35 this window.");
  }

  const headline = flagged.length
    ? "Yes — listed Fed parlays are not priced as independent legs."
    : scored.length
      ? "Listed Fed parlays are close to independence this snapshot; correlation still shows up in homemade pairs and the MVE book."
      : "Could not score listed parlays this snapshot.";

  return {
    headline,
    bullets,
    listed_flagged: flagged.length,
    listed_scored: scored.length,
    max_abs_independence_gap: maxGap == null ? null : Math.round(maxGap * 1e6) / 1e6,
    max_abs_implied_rho: maxRho == null ? null : Math.round(maxRho * 1e6) / 1e6,
    homemade_high_corr: homemadeHigh,
  };
}

export async function runKalshiParlayExperiment(
  deps: KalshiParlayDeps,
): Promise<KalshiParlaySnapshot> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const errors: string[] = [];
  const bySeries = new Map<string, KalshiQuote[]>();

  const wanted: Array<{ seriesId: string; maxPages: number }> = [
    ...FED_SERIES.map((seriesId) => ({ seriesId, maxPages: 2 })),
    ...HOMEMADE_SERIES.map((seriesId) => ({ seriesId, maxPages: 1 })),
  ];
  let skipRest = false;
  for (const { seriesId, maxPages } of wanted) {
    if (skipRest) {
      errors.push(`${seriesId}: skipped after Kalshi 429`);
      bySeries.set(seriesId, []);
      continue;
    }
    try {
      bySeries.set(seriesId, await fetchSeriesMarkets(seriesId, deps, maxPages));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${seriesId}: ${message}`);
      bySeries.set(seriesId, []);
      if (/HTTP 429/.test(message)) skipRest = true;
    }
  }

  let mve: MveCensus = { scanned: 0, two_sided: 0, empty_book: 0, sample_titles: [] };
  if (skipRest) {
    errors.push("mve: skipped after Kalshi 429");
  } else {
    try {
      mve = await fetchMveCensus(deps);
    } catch (error) {
      errors.push(`mve: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let correlations: ReturnCorr[] = [];
  if (deps.queryOhlc) {
    try {
      const since = new Date(nowMs - OHLC_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
      const bars = await deps.queryOhlc(OHLC_SYMBOLS, since);
      correlations = buildCorrelations(bars, OHLC_LOOKBACK_DAYS);
    } catch (error) {
      errors.push(`ohlc: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { rows: listed, marginals } = buildListedRows(
    bySeries.get("KXFEDCOMBO") ?? [],
    bySeries.get("KXFEDDECISION") ?? [],
    bySeries.get("KXFOMCDISSENTCOUNT") ?? [],
    nowMs,
  );
  const homemade = buildHomemadeRows(bySeries, correlations, nowMs);
  const verdict = buildVerdict(listed, homemade, marginals, mve, correlations);

  return {
    design_id: KALSHI_PARLAY_DESIGN_ID,
    slug: KALSHI_PARLAY_SLUG,
    fetched_at: new Date(nowMs).toISOString(),
    listed,
    homemade,
    marginals,
    correlations,
    mve,
    verdict,
    errors,
  };
}

export async function pacedKalshiFetchJson(
  url: string,
  opts?: { gapMs?: number; userAgent?: string; retries?: number },
): Promise<unknown> {
  const retries = opts?.retries ?? 2;
  const ua = opts?.userAgent ?? "lobster-market-pricing/kalshi-parlays";
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": ua },
      });
      if (response.ok) return await response.json();
      const detail = await response.text();
      lastError = new Error(`Kalshi HTTP ${response.status}: ${detail.slice(0, 160)}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
      if (attempt < retries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitSec = response.status === 429
          ? Math.min(3, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1.5 * 2 ** attempt)
          : Math.min(2, 2 ** attempt);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /Kalshi HTTP 4\d\d/.test(error.message) && !/429/.test(error.message)) {
        throw error;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Serialize Kalshi GETs so a Worker pass does not burst the public API. */
export function createPacedKalshiFetcher(gapMs = 550): (url: string) => Promise<unknown> {
  let last = 0;
  return async (url: string) => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return pacedKalshiFetchJson(url, { retries: 2 });
  };
}
