/**
 * Live Kalshi parlay experiment: listed Fed combos vs independence of the
 * decision × dissent legs, homemade same-horizon parlays scored with a
 * Gaussian copula using lake return correlation, and sports multivariate
 * parlays from options.kalshi_markets (KXMVE ingest: MVE combos + selected
 * legs, including last pre-settlement snapshots). Live Kalshi MVE is only a
 * fallback when the lake is empty.
 */

import {
  DISSENT_LABEL,
  KALSHI_PARLAY_DESIGN_ID,
  KALSHI_PARLAY_SLUG,
  RATE_LABEL,
  alignedReturnPair,
  encodeMveCategory,
  extractPeriod,
  isTwoSided,
  listedComboMid,
  mveTapeKind,
  parseDecisionTicker,
  parseDissentCountTicker,
  parseFedComboTicker,
  parseKalshiNumber,
  parseMveCategory,
  parseMveSelectedLegs,
  parlayGameGroup,
  pearsonCorrelation,
  hasTradableQuote,
  quoteMid,
  quoteSpread,
  scoreMultiLegParlay,
  scoreTwoLegParlay,
  sportsGameKey,
  syntheticComplementQuote,
  type FedDissentKey,
  type FedRateKey,
  type KalshiQuote,
  type MveTapeKind,
  type TwoLegScore,
} from "./kalshi-parlay";
import {
  backtestHeadline,
  backtestParlayStrategy,
  hydrateParlaySettlements,
  type ParlayBacktest,
} from "./kalshi-parlay-backtest";
import { isKalshiSettlementSource } from "../../loader/src/kalshi-settlement.js";

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
  kind: "listed_combo" | "homemade" | "sports_mve" | "crypto_mve";
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
  tape_kind?: MveTapeKind;
  aligned_at?: string | null;
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
  combo_tickers?: number;
  ever_two_sided?: number;
  sports_combos?: number;
  crypto_mve_combos?: number;
  mixed_combos?: number;
  same_game?: number;
  cross_game?: number;
  mixed_game?: number;
  two_leg?: number;
  tape_scored?: number;
  tape_flagged?: number;
  max_abs_tape_gap?: number | null;
  survives_spread_fees?: number;
  corr_room_mean?: number | null;
  corr_room_max?: number | null;
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
  sports_scored: number;
  sports_flagged: number;
  sports_same_game: number;
}

export interface KalshiParlaySnapshot {
  design_id: string;
  slug: string;
  fetched_at: string;
  listed: TwoLegRow[];
  homemade: TwoLegRow[];
  sports: TwoLegRow[];
  crypto_mves: TwoLegRow[];
  sports_source: "lake" | "live" | "none";
  marginals: MarginalCheck[];
  correlations: ReturnCorr[];
  mve: MveCensus;
  backtest: ParlayBacktest;
  verdict: KalshiParlayVerdict;
  errors: string[];
}

export interface OhlcBar {
  symbol: string;
  date: string;
  close: number;
}

export interface LakeKalshiMarket {
  series_ticker: string;
  market_ticker: string;
  event_ticker: string | null;
  title: string;
  yes_subtitle: string | null;
  theme: string;
  category: string | null;
  status: string;
  market_type: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  volume: number | null;
  close_time: string | null;
  fetched_at?: string | null;
  /** `kalshi_rfq` when the snapshot is a solicited RFQ two-way, else `kalshi`. */
  source?: string | null;
}

export interface KalshiParlayDeps {
  fetchJson: (url: string) => Promise<unknown>;
  queryOhlc?: (symbols: string[], since: string) => Promise<OhlcBar[]>;
  queryKalshiSports?: () => Promise<LakeKalshiMarket[]>;
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
    series_ticker: strip(m.series_ticker).toUpperCase() || seriesId,
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

function lakeToQuote(row: LakeKalshiMarket): KalshiQuote {
  return {
    series_ticker: row.series_ticker,
    ticker: row.market_ticker,
    event_ticker: row.event_ticker,
    title: row.title,
    yes_subtitle: row.yes_subtitle,
    yes_bid: row.yes_bid,
    yes_ask: row.yes_ask,
    yes_last: row.yes_last,
    volume: row.volume,
    close_time: row.close_time,
    status: row.status,
  };
}

function emptyMveCensus(partial?: Partial<MveCensus>): MveCensus {
  return {
    scanned: 0,
    two_sided: 0,
    empty_book: 0,
    sample_titles: [],
    combo_tickers: 0,
    ever_two_sided: 0,
    sports_combos: 0,
    crypto_mve_combos: 0,
    mixed_combos: 0,
    same_game: 0,
    cross_game: 0,
    mixed_game: 0,
    two_leg: 0,
    tape_scored: 0,
    tape_flagged: 0,
    max_abs_tape_gap: null,
    survives_spread_fees: 0,
    corr_room_mean: null,
    corr_room_max: null,
    ...partial,
  };
}

function sportsCandidate(raw: unknown): boolean {
  const rec = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  if (!rec) return false;
  const legs = parseMveSelectedLegs(raw);
  if (legs.length < 2) return false;
  const series = String(rec.series_ticker || rec.ticker || "").toUpperCase();
  if (/^KXFED|^KXCPI|^KXGDP|^KXINX|^KXRUT|^KXDJIA|^KXBTC|^KXETH|^KXWTI|^KXSOFR|^KXUST|^KXRATE/.test(series)) {
    return false;
  }
  const tape = mveTapeKind(legs.map((leg) => leg.market_ticker));
  if (tape === "crypto_mve") return false;
  if (tape === "sports" || tape === "mixed") return true;
  const blob = `${series} ${rec.mve_collection_ticker || ""} ${rec.title || ""} ${rec.category || ""}`;
  return /NFL|NBA|MLB|NHL|MLS|WNBA|NCAA|EPL|UCL|UFC|SOCCER|FOOTBALL|BASKETBALL|BASEBALL|HOCKEY|SPORT/i.test(blob)
    || String(rec.category || "").toLowerCase() === "sports";
}

function fetchedMs(row: LakeKalshiMarket): number {
  if (!row.fetched_at) return 0;
  const t = Date.parse(row.fetched_at);
  return Number.isFinite(t) ? t : 0;
}

function groupLakeByTicker(markets: LakeKalshiMarket[]): Map<string, LakeKalshiMarket[]> {
  const map = new Map<string, LakeKalshiMarket[]>();
  for (const row of markets) {
    const ticker = row.market_ticker?.toUpperCase();
    if (!ticker) continue;
    const list = map.get(ticker) ?? [];
    list.push(row);
    map.set(ticker, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => fetchedMs(b) - fetchedMs(a));
  }
  return map;
}

function isQuoteTape(row: LakeKalshiMarket): boolean {
  return !isKalshiSettlementSource(row.source);
}

function pickTwoSidedSnapshot(snaps: LakeKalshiMarket[]): LakeKalshiMarket | null {
  for (const row of snaps) {
    if (!isQuoteTape(row)) continue;
    if (isTwoSided(lakeToQuote(row))) return row;
  }
  return null;
}

function pickComboTapeSnapshot(snaps: LakeKalshiMarket[]): LakeKalshiMarket | null {
  return pickTwoSidedSnapshot(snaps)
    ?? snaps.find((row) => hasTradableQuote(lakeToQuote(row)))
    ?? null;
}

function pickNearestTradable(
  snaps: LakeKalshiMarket[],
  atMs: number,
): LakeKalshiMarket | null {
  let best: LakeKalshiMarket | null = null;
  let bestAbs = Infinity;
  for (const row of snaps) {
    if (!isQuoteTape(row)) continue;
    if (!hasTradableQuote(lakeToQuote(row))) continue;
    const delta = Math.abs(fetchedMs(row) - atMs);
    if (delta < bestAbs) {
      bestAbs = delta;
      best = row;
    }
  }
  return best;
}

function rankParlayRow(row: TwoLegRow): number {
  let score = 0;
  if (row.score.joint != null) score += 1_000_000;
  if (row.score.flags.includes("ignores_correlation")) score += 50_000;
  if (row.legs.length === 2) score += 10_000;
  if (row.score.flags.includes("same_game")) score += 5_000 + Math.round((row.score.corr_room ?? 0) * 10_000);
  score += row.combo?.volume ?? 0;
  score += Math.round((row.score.independence ?? 0) * 1000);
  return score;
}

const SPORTS_TABLE_LIMIT = 40;
const CRYPTO_TABLE_LIMIT = 20;

export function scoreMveParlays(
  markets: LakeKalshiMarket[],
  _nowMs: number,
): { sports: TwoLegRow[]; crypto_mves: TwoLegRow[]; mixed: TwoLegRow[]; all: TwoLegRow[] } {
  const byTicker = groupLakeByTicker(markets);
  const rows: TwoLegRow[] = [];
  const seenCombos = new Set<string>();
  for (const [ticker, snaps] of byTicker) {
    const comboSnap = snaps.find((row) => parseMveCategory(row.category)) ?? null;
    if (!comboSnap) continue;
    const parsed = parseMveCategory(comboSnap.category);
    if (!parsed) continue;
    if (seenCombos.has(ticker)) continue;
    seenCombos.add(ticker);
    const tapeSnap = pickComboTapeSnapshot(snaps);
    const displaySnap = tapeSnap ?? snaps[0]!;
    const comboQuote = lakeToQuote(displaySnap);
    const twoSidedTape = tapeSnap ? isTwoSided(lakeToQuote(tapeSnap)) : false;
    if (!tapeSnap && /closed|settled|finalized/i.test(displaySnap.status) && !hasTradableQuote(comboQuote)) {
      continue;
    }
    const alignAt = fetchedMs(tapeSnap ?? displaySnap);
    const alignedAt = (tapeSnap ?? displaySnap).fetched_at ?? null;
    const legs: ParlayLegView[] = [];
    const probs: number[] = [];
    const spreads: Array<number | null> = [];
    const games: string[] = [];
    let missing = 0;
    for (const spec of parsed.legs) {
      const legSnaps = byTicker.get(spec.market_ticker) ?? [];
      const legRow = pickNearestTradable(legSnaps, alignAt);
      if (!legRow) {
        missing += 1;
        continue;
      }
      const q = lakeToQuote(legRow);
      let prob = quoteMid(q);
      if (prob != null && spec.side === "no") prob = 1 - prob;
      if (prob == null || !hasTradableQuote(q)) {
        missing += 1;
        continue;
      }
      probs.push(prob);
      spreads.push(quoteSpread(q));
      games.push(sportsGameKey(spec.market_ticker, spec.event_ticker || legRow.event_ticker));
      legs.push({
        role: `${spec.side} · ${legRow.yes_subtitle || spec.market_ticker}`,
        quote: toQuoteView(q),
        selected_prob: prob,
      });
    }
    if (probs.length < 2) continue;
    const joint = listedComboMid(comboQuote);
    const score = scoreMultiLegParlay({
      probs,
      joint,
      comboSpread: twoSidedTape ? quoteSpread(comboQuote) : null,
      legSpreads: spreads,
    });
    const group = parlayGameGroup(games);
    if (group === "same_game") {
      score.flags.push("same_game");
      if (score.implied_rho != null && Math.abs(score.implied_rho) < 0.15) {
        score.flags.push("ignores_correlation");
      }
    }
    if (group === "cross_game") score.flags.push("cross_game");
    if (group === "mixed") score.flags.push("mixed_game");
    if (joint == null) {
      score.flags.push("no_combo_tape");
      score.flags.push("rfq_auction");
    } else if ((displaySnap.source || "").toLowerCase() === "kalshi_rfq") {
      score.flags.push("rfq_quote");
    } else if (!twoSidedTape) {
      score.flags.push("rfq_auction_print");
    }
    const tape = mveTapeKind(parsed.legs.map((leg) => leg.market_ticker));
    if (tape === "crypto_mve") score.flags.push("crypto_mve");
    if (tape === "mixed") score.flags.push("mixed_crypto");
    const frechetNote = group === "same_game" && probs.length >= 2
      ? `Independence is ${(score.independence * 100).toFixed(1)}¢; Fréchet high is ${(score.frechet_high * 100).toFixed(1)}¢ — ${ (score.corr_room * 100).toFixed(1)}¢ of positive correlation is unpriced if the RFQ quotes p×q.`
      : null;
    const notes = [
      tape === "crypto_mve"
        ? "Crypto target-price MVE (15m / daily) — not a sportsbook tape. Same-close crypto targets are correlated."
        : tape === "mixed"
          ? "Mixed sports props and crypto target-price legs in one CROSSCATEGORY combo."
          : group === "same_game"
            ? (frechetNote || "Same-game parlay — independence is the wrong model even before the combo quote.")
            : group === "cross_game"
              ? "Cross-game parlay — closer to independent legs."
              : "Mixed same-game and cross-game legs.",
      joint == null
        ? "Combo CLOB is empty because sports parlays are RFQ auctions (HVM). Makers quote privately; 0/0/0 is the resting book, not a missing market. Independence is the uncorrelated reservation; same-game auction fair is the Fréchet interval from the lake legs."
        : score.flags.includes("rfq_quote")
          ? "Combo mid is a solicited RFQ two-way (makers' private yes_bid / implied ask from no_bid), not a standing CLOB. The RFQ was cancelled without accepting."
          : score.flags.includes("rfq_auction_print")
          ? "Combo mid is an RFQ auction print (yes_last in (0, 1) on an empty resting book), not a standing two-sided CLOB."
          : score.flags.includes("survives_fees")
          ? "Listed combo disagrees with the product of the aligned lake legs by more than spread plus Kalshi taker fees."
          : score.flags.includes("independence_gap")
            ? "Listed combo disagrees with the product of the aligned lake legs, but the gap may not clear fees."
            : "Listed combo is within spread of the independence product of the aligned lake legs.",
      missing ? `${missing} selected legs missing a tradable lake snapshot near the combo time.` : "",
      tapeSnap && tapeSnap.fetched_at !== snaps[0]?.fetched_at
        ? `Combo mid from last ${
          (displaySnap.source || "").toLowerCase() === "kalshi_rfq"
            ? "solicited RFQ"
            : twoSidedTape
              ? "two-sided"
              : "auction-print"
        } snapshot ${tapeSnap.fetched_at}; not the latest empty RFQ book.`
        : "",
      /closed|settled|finalized/i.test(displaySnap.status)
        ? `Scored from a lake snapshot (status ${displaySnap.status}); not a live CLOB.`
        : "",
      alignedAt ? `Aligned at ${alignedAt}.` : "",
    ].filter(Boolean).join(" ");
    rows.push({
      id: displaySnap.market_ticker,
      kind: tape === "crypto_mve" ? "crypto_mve" : "sports_mve",
      meeting: parsed.collection,
      label: displaySnap.title,
      combo: toQuoteView(comboQuote),
      legs,
      score,
      rho_proxy: null,
      rho_proxy_source: null,
      notes,
      tape_kind: tape,
      aligned_at: alignedAt,
    });
  }
  rows.sort((a, b) => rankParlayRow(b) - rankParlayRow(a));
  return {
    sports: rows.filter((row) => (row.tape_kind ?? "sports") === "sports"),
    crypto_mves: rows.filter((row) => row.tape_kind === "crypto_mve"),
    mixed: rows.filter((row) => row.tape_kind === "mixed"),
    all: rows,
  };
}

/** Sports + mixed CROSSCATEGORY stacks for the sports table. Crypto target-price MVEs are split out. */
export function buildSportsRows(
  markets: LakeKalshiMarket[],
  nowMs: number,
): TwoLegRow[] {
  const scored = scoreMveParlays(markets, nowMs);
  return [...scored.sports, ...scored.mixed];
}

async function fetchLiveSportsMarkets(
  deps: KalshiParlayDeps,
): Promise<{ markets: LakeKalshiMarket[]; census: MveCensus }> {
  const empty: MveCensus = emptyMveCensus();
  const base = (deps.kalshiBase || KALSHI_PUBLIC_API_BASE).replace(/\/$/, "");
  const payload = await deps.fetchJson(`${base}/markets?mve_filter=only&status=open&limit=200`);
  const rec = asRecord(payload);
  const markets = rec?.markets;
  if (!Array.isArray(markets)) return { markets: [], census: empty };
  const census = censusFromRawMarkets(markets);
  const combos: LakeKalshiMarket[] = [];
  const legTickers: string[] = [];
  const seenLegs = new Set<string>();
  for (const raw of markets) {
    if (!sportsCandidate(raw)) continue;
    const legs = parseMveSelectedLegs(raw);
    const mapped = mapKalshiMarket("KXMVE", raw);
    if (!mapped) continue;
    const collection = typeof (raw as { mve_collection_ticker?: string }).mve_collection_ticker === "string"
      ? (raw as { mve_collection_ticker: string }).mve_collection_ticker
      : "UNKNOWN";
    combos.push(lakeMarketFromQuote(mapped, {
      theme: "sports",
      category: encodeMveCategory(collection, legs),
      market_type: "multivariate",
    }));
    for (const leg of legs) {
      if (seenLegs.has(leg.market_ticker)) continue;
      seenLegs.add(leg.market_ticker);
      legTickers.push(leg.market_ticker);
    }
    if (combos.length >= 40) break;
  }
  const out = [...combos];
  for (let i = 0; i < legTickers.length; i += 20) {
    const chunk = legTickers.slice(i, i + 20);
    const page = await deps.fetchJson(
      `${base}/markets?tickers=${encodeURIComponent(chunk.join(","))}&limit=200`,
    );
    const nested = asRecord(page)?.markets;
    if (!Array.isArray(nested)) continue;
    for (const raw of nested) {
      const mapped = mapKalshiMarket("SPORTSLEG", raw);
      if (!mapped) continue;
      out.push(lakeMarketFromQuote(mapped, {
        theme: "sports",
        category: null,
        market_type: strip((raw as { market_type?: unknown }).market_type) || null,
      }));
    }
  }
  return { markets: out, census };
}

function censusFromRawMarkets(markets: unknown[]): MveCensus {
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
  return emptyMveCensus({
    scanned: twoSided + emptyBook,
    two_sided: twoSided,
    empty_book: emptyBook,
    sample_titles: titles,
    combo_tickers: twoSided + emptyBook,
    ever_two_sided: twoSided,
  });
}

function comboLegTickers(snaps: LakeKalshiMarket[]): string[] {
  for (const row of snaps) {
    const parsed = parseMveCategory(row.category);
    if (parsed) return parsed.legs.map((leg) => leg.market_ticker);
  }
  return [];
}

export function censusFromScoredParlays(
  scored: TwoLegRow[],
  markets: LakeKalshiMarket[],
): MveCensus {
  const byTicker = groupLakeByTicker(markets);
  const comboEntries = [...byTicker.entries()].filter(([, snaps]) =>
    snaps.some((row) => parseMveCategory(row.category)),
  );
  let ever = 0;
  let latestTwo = 0;
  let empty = 0;
  let sports_combos = 0;
  let crypto_mve_combos = 0;
  let mixed_combos = 0;
  let same_game = 0;
  let cross_game = 0;
  let mixed_game = 0;
  let two_leg = 0;
  const titles: string[] = [];
  for (const [, snaps] of comboEntries) {
    if (pickTwoSidedSnapshot(snaps)) ever += 1;
    const quoteSnaps = snaps.filter(isQuoteTape);
    const latest = quoteSnaps[0] ?? snaps[0]!;
    if (isTwoSided(lakeToQuote(latest))) latestTwo += 1;
    else empty += 1;
    if (titles.length < 5 && latest.title) titles.push(latest.title.slice(0, 80));
    const tickers = comboLegTickers(snaps);
    if (tickers.length < 2) continue;
    const kind = mveTapeKind(tickers);
    if (kind === "crypto_mve") {
      crypto_mve_combos += 1;
      continue;
    }
    if (kind === "mixed") {
      mixed_combos += 1;
      continue;
    }
    sports_combos += 1;
    if (tickers.length === 2) two_leg += 1;
    const group = parlayGameGroup(tickers.map((ticker) => sportsGameKey(ticker)));
    if (group === "same_game") same_game += 1;
    else if (group === "cross_game") cross_game += 1;
    else mixed_game += 1;
  }
  const tape = scored.filter((row) => row.score.joint != null);
  const flagged = tape.filter((row) => row.score.flags.includes("independence_gap"));
  const gaps = tape
    .map((row) => row.score.gap_vs_independence)
    .filter((gap): gap is number => gap != null);
  const sameGameRooms = scored
    .filter((row) => row.score.flags.includes("same_game") && (row.tape_kind ?? "sports") !== "crypto_mve")
    .map((row) => row.score.corr_room)
    .filter((room): room is number => room != null && Number.isFinite(room));
  return emptyMveCensus({
    scanned: comboEntries.length,
    two_sided: latestTwo,
    empty_book: empty,
    sample_titles: titles,
    combo_tickers: comboEntries.length,
    ever_two_sided: ever,
    sports_combos,
    crypto_mve_combos,
    mixed_combos,
    same_game,
    cross_game,
    mixed_game,
    two_leg,
    tape_scored: tape.length,
    tape_flagged: flagged.length,
    max_abs_tape_gap: gaps.length ? Math.max(...gaps.map(Math.abs)) : null,
    survives_spread_fees: scored.filter((row) => row.score.flags.includes("survives_fees")).length,
    corr_room_mean: sameGameRooms.length
      ? sameGameRooms.reduce((a, b) => a + b, 0) / sameGameRooms.length
      : null,
    corr_room_max: sameGameRooms.length ? Math.max(...sameGameRooms) : null,
  });
}

export function censusFromLakeMarkets(markets: LakeKalshiMarket[]): MveCensus {
  return censusFromScoredParlays(scoreMveParlays(markets, 0).all, markets);
}

function lakeMarketFromQuote(
  q: KalshiQuote,
  extra: { theme: string; category: string | null; market_type: string | null },
): LakeKalshiMarket {
  return {
    series_ticker: q.series_ticker,
    market_ticker: q.ticker,
    event_ticker: q.event_ticker,
    title: q.title,
    yes_subtitle: q.yes_subtitle,
    theme: extra.theme,
    category: extra.category,
    status: q.status,
    market_type: extra.market_type,
    yes_bid: q.yes_bid,
    yes_ask: q.yes_ask,
    yes_last: q.yes_last,
    volume: q.volume,
    close_time: q.close_time,
  };
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
  sports: TwoLegRow[] = [],
  cryptoMves: TwoLegRow[] = [],
  backtest?: ParlayBacktest,
): KalshiParlayVerdict {
  const scored = listed.filter((r) => r.score.joint != null);
  const flagged = scored.filter((r) => r.score.flags.includes("independence_gap"));
  const twoSided = scored.filter((r) => r.combo?.two_sided);
  const gaps = scored
    .map((r) => r.score.gap_vs_independence)
    .filter((g): g is number => g != null);
  // 0-bid / 1-ask (or 0/1¢) cells sit on a Fréchet corner, so tetrachoric ρ
  // blows up even when the independence gap is inside the spread. Quote the
  // correlation the two-sided tape actually implies.
  const rhoSource = twoSided.length ? twoSided : scored;
  const rhos = rhoSource
    .map((r) => r.score.implied_rho)
    .filter((g): g is number => g != null);
  const maxGap = gaps.length ? Math.max(...gaps.map(Math.abs)) : null;
  const maxRho = rhos.length ? rhos.reduce((a, b) => Math.abs(a) > Math.abs(b) ? a : b) : null;
  const homemadeHigh = homemade.filter((r) => r.rho_proxy != null && Math.abs(r.rho_proxy) >= 0.35).length;
  const highCorrPairs = correlations.filter((row) => Math.abs(row.pearson) >= 0.35);
  const marginalFlags = marginals.filter((m) => m.flag).length;
  const sportsFlagged = sports.filter((r) => r.score.flags.includes("independence_gap"));
  const sportsSameGame = sports.filter((r) => r.score.flags.includes("same_game"));
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
      `Largest implied Gaussian (tetrachoric) ρ on a ${twoSided.length ? "two-sided " : ""}listed cell is ${maxRho.toFixed(2)} — the legs are not independent.`,
    );
  }
  if (marginalFlags) {
    bullets.push(
      `${marginalFlags} combo-implied marginals disagree with the standalone decision/dissent books by >3¢ — a second, cross-book kind of mispricing.`,
    );
  }
  if (mve.combo_tickers) {
    bullets.push(
      `${mve.ever_two_sided ?? 0} of ${mve.combo_tickers} lake MVE combos ever rested a two-sided book inside (0,1). Combos are HVMs: the venue is RFQ auction, not a standing CLOB.`,
    );
    bullets.push(
      `Split: ${mve.sports_combos ?? 0} sports, ${mve.crypto_mve_combos ?? 0} crypto target-price MVEs, ${mve.mixed_combos ?? 0} mixed. ${mve.same_game ?? 0} same-game, ${mve.cross_game ?? 0} cross-game, ${mve.two_leg ?? 0} two-leg.`,
    );
    if ((mve.same_game ?? 0) > 0) {
      const maxRoom = mve.corr_room_max;
      const meanRoom = mve.corr_room_mean;
      const roomTxt = maxRoom != null
        ? ` Quoting independence would ignore up to ${(maxRoom * 100).toFixed(1)}¢ of positive correlation versus Fréchet high${meanRoom != null ? ` (mean ${(meanRoom * 100).toFixed(1)}¢ among scored same-game rows)` : ""}.`
        : "";
      bullets.push(
        `${mve.same_game} lake sports combos are same-game (correlated legs). ${mve.cross_game ?? 0} are cross-game.${roomTxt} Solicited RFQ two-ways and volume-backed prints are what show whether makers actually charge that correlation.`,
      );
    }
    if (mve.tape_scored) {
      bullets.push(
        `${mve.tape_flagged ?? 0} of ${mve.tape_scored} combo tapes (two-sided book, solicited RFQ quote, or auction print) disagree with independence after spread; ${mve.survives_spread_fees ?? 0} still clear Kalshi taker fees.`,
      );
    } else {
      bullets.push(
        "No public combo print this window — maker RFQ quotes stay private until the hourly ingest solicits them (capped same-game RFQ probe). Same-game auction fair is the Fréchet interval from the lake legs; a maker quoting p×q on a same-game stack is selling correlation too cheap. Cross-game independence is closer to the right reservation.",
      );
    }
  } else if (sports.length) {
    bullets.push(
      `${sportsFlagged.length} of ${sports.length} sports parlays have a two-sided combo tape that disagrees with independence; ${sportsSameGame.length} are same-game.`,
    );
  } else if (mve.scanned) {
    bullets.push(
      `Public combo CLOB: ${mve.two_sided} of ${mve.scanned} scanned MVE markets have a two-sided book inside (0,1). Sports parlays are ingested as MVE combos plus selected legs — not the full sports catalog.`,
    );
  }
  if (cryptoMves.length && !mve.combo_tickers) {
    bullets.push(
      `${cryptoMves.length} crypto target-price MVEs scored separately from sports — independence on same-close crypto targets is a different question.`,
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
  if (backtest) {
    const s = backtest.strategy;
    if (s.settled) {
      const yesSign = s.yes_pnl >= 0 ? "+" : "−";
      const noSign = s.no_pnl >= 0 ? "+" : "−";
      bullets.push(
        `Live filter backtest: ${s.settled} settled RFQ${s.settled === 1 ? "" : "s"} that would have been accepted, ${s.yes_wins} YES hits (${s.hit_rate != null ? `${(s.hit_rate * 100).toFixed(0)}%` : "—"}) on 10-contract tickets. BUY YES at the ask ${yesSign}$${Math.abs(s.yes_pnl).toFixed(2)}; the 2026-09-14 BUY NO fills would have been ${noSign}$${Math.abs(s.no_pnl).toFixed(2)}.`,
      );
    } else if (backtest.would_accept) {
      bullets.push(
        `Live filter would accept ${backtest.would_accept} of ${backtest.same_game} same-game RFQ two-ways this window; none have a settlement 0/1 yet.`,
      );
    } else if (backtest.rfq_quotes) {
      bullets.push(
        `${backtest.rfq_quotes} sports RFQ two-ways in the lake; none cleared the live same-game filter.`,
      );
    }
  }

  const backtestLine = backtest ? backtestHeadline(backtest) : null;
  const headline = backtestLine
    ? backtestLine
    : flagged.length
    ? "Yes — listed Fed parlays are not priced as independent legs."
    : (mve.tape_flagged ?? 0)
      ? "Listed Fed parlays are close to independence this snapshot; the sports combo tape is not."
      : (mve.same_game ?? 0) > 0
        ? `Kalshi offers same-game parlays with correlated legs — quoting p×q would ignore up to ${((mve.corr_room_max ?? 0) * 100).toFixed(0)}¢ of positive correlation.`
      : (mve.combo_tickers && (mve.ever_two_sided ?? 0) === 0)
        ? "Kalshi sports parlays are RFQ auctions — empty 0/0/0 books are the venue, not a missing market."
        : scored.length
          ? "Listed Fed parlays are close to independence this snapshot; correlation still shows up in homemade pairs and sports MVEs."
          : "Could not score listed parlays this snapshot.";

  return {
    headline,
    bullets,
    listed_flagged: flagged.length,
    listed_scored: scored.length,
    max_abs_independence_gap: maxGap == null ? null : Math.round(maxGap * 1e6) / 1e6,
    max_abs_implied_rho: maxRho == null ? null : Math.round(maxRho * 1e6) / 1e6,
    homemade_high_corr: homemadeHigh,
    sports_scored: sports.length,
    sports_flagged: sportsFlagged.length,
    sports_same_game: sportsSameGame.length,
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

  let mve: MveCensus = emptyMveCensus();
  let sportsMarkets: LakeKalshiMarket[] = [];
  let sportsSource: KalshiParlaySnapshot["sports_source"] = "none";
  if (deps.queryKalshiSports) {
    try {
      sportsMarkets = await deps.queryKalshiSports();
    } catch (error) {
      errors.push(`sports lake: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sportsMarkets.length) {
    sportsSource = "lake";
    if (!skipRest) {
      try {
        const hydrated = await hydrateParlaySettlements(sportsMarkets, deps.fetchJson, {
          base: deps.kalshiBase || KALSHI_PUBLIC_API_BASE,
        });
        for (const row of hydrated.extra) {
          sportsMarkets.push({
            series_ticker: row.market_ticker.match(/^(KX[A-Z]+)/)?.[1] ?? "KXMVE",
            market_ticker: row.market_ticker,
            event_ticker: row.event_ticker ?? null,
            title: row.title,
            yes_subtitle: null,
            theme: "sports",
            category: row.category,
            status: row.status,
            market_type: "multivariate",
            yes_bid: row.yes_bid,
            yes_ask: row.yes_ask,
            yes_last: row.yes_last,
            volume: null,
            close_time: row.close_time ?? null,
            fetched_at: row.fetched_at ?? null,
            source: row.source ?? "kalshi_settlement",
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`settlement hydrate: ${message}`);
        if (/HTTP 429/.test(message)) skipRest = true;
      }
    }
  } else if (skipRest) {
    errors.push("mve: skipped after Kalshi 429");
    errors.push("sports: skipped after Kalshi 429");
  } else {
    try {
      const live = await fetchLiveSportsMarkets(deps);
      sportsMarkets = live.markets;
      mve = live.census;
      if (sportsMarkets.length) sportsSource = "live";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`mve: ${message}`);
      if (/HTTP 429/.test(message)) {
        errors.push("sports: skipped after Kalshi 429");
      }
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
  const scoredMve = scoreMveParlays(sportsMarkets, nowMs);
  const sports = [...scoredMve.sports, ...scoredMve.mixed].slice(0, SPORTS_TABLE_LIMIT);
  const cryptoMves = scoredMve.crypto_mves.slice(0, CRYPTO_TABLE_LIMIT);
  if (sportsMarkets.length) {
    mve = censusFromScoredParlays(scoredMve.all, sportsMarkets);
  }
  const backtest = backtestParlayStrategy(sportsMarkets);
  const verdict = buildVerdict(listed, homemade, marginals, mve, correlations, sports, cryptoMves, backtest);

  return {
    design_id: KALSHI_PARLAY_DESIGN_ID,
    slug: KALSHI_PARLAY_SLUG,
    fetched_at: new Date(nowMs).toISOString(),
    listed,
    homemade,
    sports,
    crypto_mves: cryptoMves,
    sports_source: sportsSource,
    marginals,
    correlations,
    mve,
    backtest,
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

/** Isolate cache TTL: pin good snapshots, but only briefly pin a 429/empty miss. */
export function kalshiParlayCacheTtlMs(snapshot: {
  listed: unknown[];
  sports?: unknown[];
  crypto_mves?: unknown[];
  errors: string[];
}): number {
  const scored = snapshot.listed.length
    + (snapshot.sports?.length ?? 0)
    + (snapshot.crypto_mves?.length ?? 0);
  if (scored === 0 && snapshot.errors.length > 0) return 90_000;
  return 10 * 60 * 1000;
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
