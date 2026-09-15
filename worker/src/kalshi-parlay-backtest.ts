/**
 * Backtest the live same-game parlay filter (evaluateParlayQuote) on lake
 * RFQ two-ways graded by settlement 0/1, plus actual executor fills
 * (source=kalshi_parlay_fill) from the Kalshi portfolio.
 *
 * Intended fill: BUY YES at the RFQ ask (what the executor asked for).
 * Production 2026-09-14 fills were BUY NO at 1 − yes_bid — report that
 * P&L separately so last night is not mixed into the strategy score.
 */

import {
  evaluateParlayQuote,
  PARLAY_MAX_CONTRACTS,
} from "../../loader/src/kalshi-parlay-filter.js";
import {
  isKalshiParlayFillSource,
  parseFillSide,
} from "../../loader/src/kalshi-parlay-fills.js";
import {
  inferComboSettlement,
  isKalshiSettlementSource,
  settlementYes,
} from "../../loader/src/kalshi-settlement.js";
import {
  hasTradableQuote,
  kalshiTakerFee,
  mveTapeKind,
  parseMveCategory,
  parlayGameGroup,
  quoteMid,
  sportsGameKey,
} from "./kalshi-parlay";

const RFQ_SOURCE = "kalshi_rfq";
const FILL_TABLE_LIMIT = 24;

export interface ParlayBacktestMarket {
  market_ticker: string;
  event_ticker?: string | null;
  title: string;
  category: string | null;
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  no_bid?: number | null;
  volume?: number | null;
  liquidity?: number | null;
  yes_subtitle?: string | null;
  close_time?: string | null;
  fetched_at?: string | null;
  source?: string | null;
  result?: unknown;
}

export interface ParlayBacktestFill {
  market_ticker: string;
  title: string;
  quoted_at: string | null;
  p: number;
  q: number;
  yes_bid: number;
  yes_ask: number;
  independence: number;
  corr_room: number;
  would_accept: boolean;
  reasons: string[];
  settlement: 0 | 1 | null;
  yes_pnl: number | null;
  no_pnl: number | null;
}

export interface ParlayBacktestCohort {
  n: number;
  settled: number;
  yes_wins: number;
  hit_rate: number | null;
  yes_pnl: number;
  no_pnl: number;
  avg_ask: number | null;
  avg_corr_room: number | null;
}

export interface ParlayLiveFill {
  market_ticker: string;
  title: string;
  quoted_at: string | null;
  fill_side: "yes" | "no";
  contracts: number;
  yes_price: number;
  no_price: number;
  fee: number;
  settlement: 0 | 1 | null;
  actual_pnl: number | null;
  yes_counterfactual_pnl: number | null;
}

export interface ParlayLiveCohort {
  n: number;
  settled: number;
  wins: number;
  hit_rate: number | null;
  actual_pnl: number;
  yes_counterfactual_pnl: number;
  fills: ParlayLiveFill[];
}

export interface ParlayBacktest {
  contracts: number;
  rfq_quotes: number;
  aligned: number;
  same_game: number;
  would_accept: number;
  strategy: ParlayBacktestCohort;
  all_rfq: ParlayBacktestCohort;
  live: ParlayLiveCohort;
  fills: ParlayBacktestFill[];
  notes: string[];
}

function fetchedMs(row: ParlayBacktestMarket): number {
  if (!row.fetched_at) return 0;
  const t = Date.parse(row.fetched_at);
  return Number.isFinite(t) ? t : 0;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function hitRate(wins: number, settled: number): number | null {
  if (!settled) return null;
  return wins / settled;
}

function emptyCohort(): ParlayBacktestCohort {
  return {
    n: 0,
    settled: 0,
    yes_wins: 0,
    hit_rate: null,
    yes_pnl: 0,
    no_pnl: 0,
    avg_ask: null,
    avg_corr_room: null,
  };
}

function emptyLive(): ParlayLiveCohort {
  return {
    n: 0,
    settled: 0,
    wins: 0,
    hit_rate: null,
    actual_pnl: 0,
    yes_counterfactual_pnl: 0,
    fills: [],
  };
}

function emptyBacktest(contracts: number, notes: string[] = []): ParlayBacktest {
  return {
    contracts,
    rfq_quotes: 0,
    aligned: 0,
    same_game: 0,
    would_accept: 0,
    strategy: emptyCohort(),
    all_rfq: emptyCohort(),
    live: emptyLive(),
    fills: [],
    notes,
  };
}

function groupByTicker(markets: ParlayBacktestMarket[]): Map<string, ParlayBacktestMarket[]> {
  const map = new Map<string, ParlayBacktestMarket[]>();
  for (const row of markets) {
    const ticker = row.market_ticker?.trim().toUpperCase();
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

function isRfqTwoWay(row: ParlayBacktestMarket): boolean {
  if (String(row.source ?? "").toLowerCase() !== RFQ_SOURCE) return false;
  if (isKalshiSettlementSource(row.source)) return false;
  const bid = row.yes_bid;
  const ask = row.yes_ask;
  return bid != null && ask != null
    && Number.isFinite(bid) && Number.isFinite(ask)
    && bid >= 0 && ask < 1 && ask > 0 && ask >= bid;
}

function tickerSettlement(snaps: ParlayBacktestMarket[]): 0 | 1 | null {
  for (const row of snaps) {
    const yes = settlementYes(row);
    if (yes === 0 || yes === 1) return yes;
  }
  return null;
}

function nearestTradable(
  snaps: ParlayBacktestMarket[],
  atMs: number,
): ParlayBacktestMarket | null {
  let best: ParlayBacktestMarket | null = null;
  let bestAbs = Infinity;
  for (const row of snaps) {
    if (isKalshiSettlementSource(row.source)) continue;
    if (isKalshiParlayFillSource(row.source)) continue;
    if (!hasTradableQuote(row)) continue;
    const delta = Math.abs(fetchedMs(row) - atMs);
    if (delta < bestAbs) {
      bestAbs = delta;
      best = row;
    }
  }
  return best;
}

function liveFillPnl(
  fillSide: "yes" | "no",
  settlement: 0 | 1,
  yesPrice: number,
  noPrice: number,
  contracts: number,
  feeTotal: number,
): { actual: number; yes_counterfactual: number } {
  const yesFee = contracts * kalshiTakerFee(yesPrice);
  const actual = fillSide === "yes"
    ? contracts * (settlement - yesPrice) - feeTotal
    : contracts * ((1 - settlement) - noPrice) - feeTotal;
  const yes_counterfactual = contracts * (settlement - yesPrice) - yesFee;
  return { actual: round4(actual), yes_counterfactual: round4(yes_counterfactual) };
}

function scoreLiveFills(
  markets: ParlayBacktestMarket[],
  byTicker: Map<string, ParlayBacktestMarket[]>,
): ParlayLiveCohort {
  const tickets: ParlayLiveFill[] = [];
  for (const row of markets) {
    if (!isKalshiParlayFillSource(row.source)) continue;
    const fill_side = parseFillSide(row.yes_subtitle);
    const yes_price = row.yes_bid;
    const no_price = row.no_bid ?? (yes_price != null ? 1 - yes_price : null);
    const contracts = row.volume != null && row.volume > 0
      ? row.volume
      : PARLAY_MAX_CONTRACTS;
    if (!fill_side || yes_price == null || no_price == null) continue;
    const fee = row.liquidity != null && Number.isFinite(row.liquidity)
      ? row.liquidity
      : contracts * kalshiTakerFee(fill_side === "no" ? no_price : yes_price);
    const settlement = tickerSettlement(byTicker.get(row.market_ticker) ?? []);
    const pnl = settlement === 0 || settlement === 1
      ? liveFillPnl(fill_side, settlement, yes_price, no_price, contracts, fee)
      : { actual: null, yes_counterfactual: null };
    tickets.push({
      market_ticker: row.market_ticker,
      title: row.title,
      quoted_at: row.fetched_at ?? null,
      fill_side,
      contracts,
      yes_price,
      no_price,
      fee,
      settlement,
      actual_pnl: pnl.actual,
      yes_counterfactual_pnl: pnl.yes_counterfactual,
    });
  }
  tickets.sort((a, b) => (b.quoted_at || "").localeCompare(a.quoted_at || ""));
  let settled = 0;
  let wins = 0;
  let actual_pnl = 0;
  let yes_counterfactual_pnl = 0;
  for (const ticket of tickets) {
    if (ticket.settlement !== 0 && ticket.settlement !== 1) continue;
    settled += 1;
    const won = ticket.fill_side === "yes" ? ticket.settlement === 1 : ticket.settlement === 0;
    if (won) wins += 1;
    if (ticket.actual_pnl != null) actual_pnl += ticket.actual_pnl;
    if (ticket.yes_counterfactual_pnl != null) yes_counterfactual_pnl += ticket.yes_counterfactual_pnl;
  }
  return {
    n: tickets.length,
    settled,
    wins,
    hit_rate: hitRate(wins, settled),
    actual_pnl: round4(actual_pnl),
    yes_counterfactual_pnl: round4(yes_counterfactual_pnl),
    fills: tickets.slice(0, FILL_TABLE_LIMIT),
  };
}

function fillPnl(
  settlement: 0 | 1,
  yesBid: number,
  yesAsk: number,
  contracts: number,
): { yes_pnl: number; no_pnl: number } {
  const noAsk = 1 - yesBid;
  const yes = contracts * (settlement - yesAsk - kalshiTakerFee(yesAsk));
  const no = contracts * ((1 - settlement) - noAsk - kalshiTakerFee(noAsk));
  return { yes_pnl: round4(yes), no_pnl: round4(no) };
}

function summarize(fills: ParlayBacktestFill[]): ParlayBacktestCohort {
  const asks: number[] = [];
  const rooms: number[] = [];
  let settled = 0;
  let yesWins = 0;
  let yesPnl = 0;
  let noPnl = 0;
  for (const fill of fills) {
    asks.push(fill.yes_ask);
    rooms.push(fill.corr_room);
    if (fill.settlement !== 0 && fill.settlement !== 1) continue;
    settled += 1;
    if (fill.settlement === 1) yesWins += 1;
    if (fill.yes_pnl != null) yesPnl += fill.yes_pnl;
    if (fill.no_pnl != null) noPnl += fill.no_pnl;
  }
  return {
    n: fills.length,
    settled,
    yes_wins: yesWins,
    hit_rate: hitRate(yesWins, settled),
    yes_pnl: round4(yesPnl),
    no_pnl: round4(noPnl),
    avg_ask: mean(asks),
    avg_corr_room: mean(rooms),
  };
}

function scoreQuote(
  combo: ParlayBacktestMarket,
  parsed: NonNullable<ReturnType<typeof parseMveCategory>>,
  byTicker: Map<string, ParlayBacktestMarket[]>,
  contracts: number,
): ParlayBacktestFill | null {
  const atMs = fetchedMs(combo);
  const sides: Array<"yes" | "no"> = [];
  const games: string[] = [];
  const probs: number[] = [];
  for (const spec of parsed.legs) {
    const legSnaps = byTicker.get(spec.market_ticker) ?? [];
    const legRow = nearestTradable(legSnaps, atMs);
    if (!legRow) return null;
    let prob = quoteMid(legRow);
    if (prob != null && spec.side === "no") prob = 1 - prob;
    if (prob == null || !hasTradableQuote(legRow)) return null;
    sides.push(spec.side);
    probs.push(prob);
    games.push(sportsGameKey(spec.market_ticker, spec.event_ticker || legRow.event_ticker));
  }
  if (probs.length !== 2) return null;
  const sameGame = parlayGameGroup(games) === "same_game";
  const decision = evaluateParlayQuote({
    market_ticker: combo.market_ticker,
    same_game: sameGame,
    sides,
    p: probs[0]!,
    q: probs[1]!,
    yes_bid: combo.yes_bid ?? 0,
    yes_ask: combo.yes_ask ?? 0,
    quote_id: "lake_rfq",
  });
  const comboSettle = tickerSettlement(byTicker.get(combo.market_ticker) ?? []);
  const legSettle = inferComboSettlement(parsed.legs.map((spec) => ({
    side: spec.side,
    settlement: tickerSettlement(byTicker.get(spec.market_ticker) ?? []),
  })));
  const settlement = comboSettle ?? legSettle;
  const pnl = settlement === 0 || settlement === 1
    ? fillPnl(settlement, combo.yes_bid ?? 0, combo.yes_ask ?? 0, contracts)
    : { yes_pnl: null, no_pnl: null };
  return {
    market_ticker: combo.market_ticker,
    title: combo.title,
    quoted_at: combo.fetched_at ?? null,
    p: probs[0]!,
    q: probs[1]!,
    yes_bid: combo.yes_bid ?? 0,
    yes_ask: combo.yes_ask ?? 0,
    independence: decision.independence,
    corr_room: decision.corr_room,
    would_accept: decision.ok,
    reasons: decision.reasons,
    settlement,
    yes_pnl: pnl.yes_pnl,
    no_pnl: pnl.no_pnl,
  };
}

/**
 * One fill per combo: the earliest RFQ two-way with aligned legs.
 * The 5-minute live bot takes at most one book per pass; hourly RFQ
 * history on the same ticker should not compound into 30 tickets.
 */
export function backtestParlayStrategy(
  markets: ParlayBacktestMarket[],
  opts?: { contracts?: number },
): ParlayBacktest {
  const contracts = opts?.contracts && opts.contracts > 0
    ? Math.min(PARLAY_MAX_CONTRACTS, Math.floor(opts.contracts))
    : PARLAY_MAX_CONTRACTS;
  if (!markets.length) {
    return emptyBacktest(contracts, ["No sports lake rows to backtest."]);
  }
  const byTicker = groupByTicker(markets);
  const firstRfq: ParlayBacktestFill[] = [];
  let rfqQuotes = 0;
  for (const [, snaps] of byTicker) {
    const comboSnap = snaps.find((row) => parseMveCategory(row.category));
    if (!comboSnap) continue;
    const parsed = parseMveCategory(comboSnap.category);
    if (!parsed || parsed.legs.length !== 2) continue;
    if (mveTapeKind(parsed.legs.map((leg) => leg.market_ticker)) !== "sports") continue;
    const rfqs = snaps.filter(isRfqTwoWay).sort((a, b) => fetchedMs(a) - fetchedMs(b));
    if (!rfqs.length) continue;
    rfqQuotes += 1;
    let scored: ParlayBacktestFill | null = null;
    for (const rfq of rfqs) {
      scored = scoreQuote(rfq, parsed, byTicker, contracts);
      if (scored) break;
    }
    if (scored) firstRfq.push(scored);
  }

  const aligned = firstRfq;
  const sameGame = aligned.filter((row) => !row.reasons.includes("not_same_game"));
  const wouldAccept = sameGame.filter((row) => row.would_accept);
  const notes: string[] = [];
  if (!rfqQuotes) {
    notes.push("No solicited RFQ two-ways (source=kalshi_rfq) on sports two-leg combos this window.");
  } else if (!wouldAccept.length) {
    notes.push("RFQ tape is present, but no quote cleared the live filter (same-game, same-side, corr room, spread, φ).");
  }
  if (wouldAccept.some((row) => row.settlement == null)) {
    notes.push("Some filter-pass quotes have not settled yet — P&L is only on resolved tickets.");
  }
  if (!wouldAccept.some((row) => row.settlement != null) && wouldAccept.length) {
    notes.push("Filter-pass quotes are still open. Settlement 0/1 lands as source=kalshi_settlement on the hourly KXMVE pass.");
  }
  notes.push(
    "Strategy P&L is BUY YES at the RFQ ask minus Kalshi taker fees, 10 contracts. "
    + "NO P&L is what production realized on 2026-09-14 when accepted_side=yes filled BUY NO.",
  );
  const live = scoreLiveFills(markets, byTicker);
  if (!live.n) {
    notes.push(
      "No source=kalshi_parlay_fill rows yet. The executor publishes portfolio combo fills on each pass — last night's BUY NO tickets land after that ingest.",
    );
  } else if (live.settled) {
    notes.push(
      `Live fills: ${live.settled} settled tickets, actual P&L ${live.actual_pnl >= 0 ? "+" : "−"}$${Math.abs(live.actual_pnl).toFixed(2)} versus YES-at-ask ${live.yes_counterfactual_pnl >= 0 ? "+" : "−"}$${Math.abs(live.yes_counterfactual_pnl).toFixed(2)}.`,
    );
  }

  return {
    contracts,
    rfq_quotes: rfqQuotes,
    aligned: aligned.length,
    same_game: sameGame.length,
    would_accept: wouldAccept.length,
    strategy: summarize(wouldAccept),
    all_rfq: summarize(sameGame),
    live,
    fills: wouldAccept
      .slice()
      .sort((a, b) => {
        const aSettled = a.settlement != null ? 1 : 0;
        const bSettled = b.settlement != null ? 1 : 0;
        if (aSettled !== bSettled) return bSettled - aSettled;
        return (b.quoted_at || "").localeCompare(a.quoted_at || "");
      })
      .slice(0, FILL_TABLE_LIMIT),
    notes,
  };
}

export function backtestHeadline(backtest: ParlayBacktest): string | null {
  const live = backtest.live;
  if (live.settled) {
    const verb = live.actual_pnl >= 0 ? "made" : "lost";
    const yesVerb = live.yes_counterfactual_pnl >= 0 ? "made" : "lost";
    return `Last night's ${live.settled} live fill${live.settled === 1 ? "" : "s"} ${verb} $${Math.abs(live.actual_pnl).toFixed(2)} (${live.wins}/${live.settled} filled-side hits). Buying YES at the same prices would have ${yesVerb} $${Math.abs(live.yes_counterfactual_pnl).toFixed(2)}.`;
  }
  const s = backtest.strategy;
  if (!s.settled) return null;
  const yesVerb = s.yes_pnl >= 0 ? "made" : "lost";
  const noVerb = s.no_pnl >= 0 ? "made" : "lost";
  return `The live YES filter ${yesVerb} $${Math.abs(s.yes_pnl).toFixed(2)} on ${s.settled} settled RFQ${s.settled === 1 ? "" : "s"} (${s.yes_wins}/${s.settled} YES hits). Accidental BUY NO on the same tickets ${noVerb} $${Math.abs(s.no_pnl).toFixed(2)}.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strip(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function num(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Tickers with an RFQ two-way but no settlement 0/1 in the lake yet. */
export function missingSettlementTickers(markets: ParlayBacktestMarket[]): string[] {
  const byTicker = groupByTicker(markets);
  const out: string[] = [];
  for (const [ticker, snaps] of byTicker) {
    if (!snaps.some((row) => parseMveCategory(row.category))) continue;
    if (!snaps.some(isRfqTwoWay) && !snaps.some((row) => isKalshiParlayFillSource(row.source))) continue;
    if (tickerSettlement(snaps) != null) continue;
    out.push(ticker);
  }
  return out;
}

export function settlementRowFromKalshiMarket(
  raw: unknown,
  prior?: ParlayBacktestMarket | null,
): ParlayBacktestMarket | null {
  const m = asRecord(raw);
  if (!m) return null;
  const ticker = strip(m.ticker).toUpperCase();
  if (!ticker) return null;
  const status = strip(m.status) || "unknown";
  const last = num(m.last_price_dollars ?? m.last_price);
  const yes = settlementYes({
    status,
    yes_bid: num(m.yes_bid_dollars ?? m.yes_bid),
    yes_ask: num(m.yes_ask_dollars ?? m.yes_ask),
    yes_last: last,
    result: m.result,
  });
  if (yes !== 0 && yes !== 1) return null;
  return {
    market_ticker: ticker,
    event_ticker: strip(m.event_ticker).toUpperCase() || prior?.event_ticker || null,
    title: strip(m.title) || prior?.title || ticker,
    category: prior?.category ?? null,
    status: "settled",
    yes_bid: yes,
    yes_ask: yes,
    yes_last: yes,
    close_time: strip(m.close_time) || prior?.close_time || null,
    fetched_at: strip(m.close_time) || strip(m.expiration_time) || new Date().toISOString(),
    source: "kalshi_settlement",
    result: m.result,
  };
}

/**
 * Fill missing combo settlements from Get Markets?tickers=… (paced by the
 * caller). Lake settlement rows win once the hourly pass publishes them.
 */
export async function hydrateParlaySettlements(
  markets: ParlayBacktestMarket[],
  fetchJson: (url: string) => Promise<unknown>,
  opts?: { base?: string; maxTickers?: number },
): Promise<{ extra: ParlayBacktestMarket[]; fetched: number }> {
  const base = (opts?.base || "https://api.elections.kalshi.com/trade-api/v2").replace(/\/$/, "");
  const maxTickers = Math.min(80, Math.max(0, opts?.maxTickers ?? 40));
  const missing = missingSettlementTickers(markets).slice(0, maxTickers);
  if (!missing.length) return { extra: [], fetched: 0 };
  const byTicker = groupByTicker(markets);
  const extra: ParlayBacktestMarket[] = [];
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const url = `${base}/markets?tickers=${encodeURIComponent(chunk.join(","))}&limit=200`;
    const payload = await fetchJson(url);
    const nested = asRecord(payload)?.markets;
    if (!Array.isArray(nested)) continue;
    for (const raw of nested) {
      const prior = (byTicker.get(strip(asRecord(raw)?.ticker).toUpperCase()) ?? [])[0] ?? null;
      const row = settlementRowFromKalshiMarket(raw, prior);
      if (row) extra.push(row);
    }
  }
  return { extra, fetched: extra.length };
}
