/**
 * Settlement-graded bakeoff of parlay books vs the live corr-room YES filter.
 *
 * Corr-room hunts a pricing error (makers quoting independence on correlated
 * same-game legs). Last night's tape showed that filter taking nothing while
 * combo YES — the cheap side of a $1 binary — had the payoff table that paid.
 * These books grade that shape on the same lake fills + RFQ two-ways.
 */

import {
  evaluateParlayQuote,
  PARLAY_MAX_CONTRACTS,
  sameSide as legsSameSide,
} from "../../loader/src/kalshi-parlay-filter.js";
import { isKalshiParlayFillSource } from "../../loader/src/kalshi-parlay-fills.js";
import {
  inferComboSettlement,
  isKalshiSettlementSource,
  settlementYes,
} from "../../loader/src/kalshi-settlement.js";
import {
  hasTradableQuote,
  kalshiTakerFee,
  parseMveCategory,
  parlayGameGroup,
  quoteMid,
  sportsGameKey,
} from "./kalshi-parlay";
import {
  hydrateParlaySettlements,
  type ParlayBacktestMarket,
} from "./kalshi-parlay-backtest";
import type { LakeKalshiMarket } from "./kalshi-parlay-experiment";

export const KALSHI_PARLAY_BOOKS_SLUG = "kalshi-parlay-books";
export const KALSHI_PARLAY_PAYOFFS_SLUG = "kalshi-parlay-payoffs";
export const KALSHI_PARLAY_BOOKS_DESIGN_ID = "kalshi-parlay-books-v1";

/** Buy YES when the ask is at most 30¢ — breakeven hit rate ~31% after fees. */
export const PAYOFF_YES_MAX_ASK = 0.30;
/** Buy the cheaper side when it costs at most 50¢ (positively skewed). */
export const UNDERDOG_MAX_COST = 0.50;

const RFQ_SOURCE = "kalshi_rfq";
const TICKET_TABLE_LIMIT = 24;

export type ParlayBookId =
  | "corr_room_yes"
  | "underdog"
  | "payoff_yes"
  | "same_game_underdog"
  | "always_yes"
  | "always_no";

export type ParlayBookSide = "yes" | "no" | "skip";
export type ParlayTicketUniverse = "fill" | "rfq";

export interface ParlayBookDef {
  id: ParlayBookId;
  name: string;
  thesis: string;
}

export const PARLAY_BOOKS: readonly ParlayBookDef[] = [
  {
    id: "corr_room_yes",
    name: "Corr-room YES",
    thesis:
      "Live filter: buy combo YES on a same-game same-side two-leg RFQ quoted near independence (corr room ≥ 15¢, ask ≤ p×q + 2¢, |φ| < 0.15, spread ≤ 8¢).",
  },
  {
    id: "underdog",
    name: "Underdog side",
    thesis:
      "Buy whichever side costs ≤ 50¢. Combo YES is usually that side; you only need to hit more often than price + fee.",
  },
  {
    id: "payoff_yes",
    name: "Payoff YES (≤ 30¢)",
    thesis:
      "Buy combo YES only when the ask is ≤ 30¢ (~2:1 after fees). Stricter than underdog — skips 30–50¢ YES.",
  },
  {
    id: "same_game_underdog",
    name: "Same-game underdog",
    thesis:
      "Underdog side, but only two-leg same-game same-side stacks. Keeps the correlated universe; drops independence / φ gates.",
  },
  {
    id: "always_yes",
    name: "Always YES",
    thesis: "Baseline: buy YES on every settled ticket at the same prices.",
  },
  {
    id: "always_no",
    name: "Always NO",
    thesis: "Baseline: buy NO on every settled ticket — last night's production book.",
  },
];

export interface ParlayBookTicket {
  market_ticker: string;
  title: string;
  quoted_at: string | null;
  universe: ParlayTicketUniverse;
  yes_price: number;
  no_price: number;
  contracts: number;
  p: number | null;
  q: number | null;
  same_game: boolean | null;
  same_side: boolean | null;
  corr_room: number | null;
  independence: number | null;
  phi: number | null;
  corr_room_ok: boolean;
  settlement: 0 | 1 | null;
}

export interface ParlayBookScore {
  taken: number;
  settled: number;
  wins: number;
  hit_rate: number | null;
  pnl: number;
  avg_price: number | null;
  avg_rr: number | null;
  breakeven: number | null;
}

export interface ParlayBookResult extends ParlayBookDef {
  fills: ParlayBookScore;
  rfq: ParlayBookScore;
  combined: ParlayBookScore;
}

export interface ParlayPayoffBucket {
  lo: number;
  hi: number;
  label: string;
  n: number;
  hits: number;
  hit_rate: number | null;
  avg_yes: number | null;
  breakeven: number | null;
  yes_pnl: number;
  no_pnl: number;
  avg_yes_win: number | null;
  avg_yes_loss: number | null;
  yes_rr: number | null;
}

export interface ParlayUniverseCensus {
  n: number;
  settled: number;
}

export interface KalshiParlayBooksSnapshot {
  design_id: string;
  slug: string;
  fetched_at: string;
  contracts: number;
  payoff_yes_max_ask: number;
  underdog_max_cost: number;
  universes: {
    fills: ParlayUniverseCensus;
    rfq: ParlayUniverseCensus;
    combined: ParlayUniverseCensus;
  };
  books: ParlayBookResult[];
  buckets: ParlayPayoffBucket[];
  tickets: ParlayBookTicket[];
  headline: string;
  bullets: string[];
  notes: string[];
  errors: string[];
}

export const PAYOFF_BUCKETS: ReadonlyArray<{ lo: number; hi: number; label: string }> = [
  { lo: 0, hi: 0.10, label: "0–10¢" },
  { lo: 0.10, hi: 0.20, label: "10–20¢" },
  { lo: 0.20, hi: 0.30, label: "20–30¢" },
  { lo: 0.30, hi: 0.40, label: "30–40¢" },
  { lo: 0.40, hi: 0.50, label: "40–50¢" },
  { lo: 0.50, hi: 0.70, label: "50–70¢" },
  { lo: 0.70, hi: 1, label: "70¢+" },
];

export function costWithFee(price: number): number {
  return price + kalshiTakerFee(price);
}

export function rewardRisk(price: number): number | null {
  const risk = costWithFee(price);
  if (!(risk > 0)) return null;
  return (1 - risk) / risk;
}

export function decideParlayBook(id: ParlayBookId, ticket: ParlayBookTicket): ParlayBookSide {
  const yesCost = costWithFee(ticket.yes_price);
  const noCost = costWithFee(ticket.no_price);
  switch (id) {
    case "corr_room_yes":
      return ticket.corr_room_ok ? "yes" : "skip";
    case "payoff_yes":
      return ticket.yes_price > 0 && ticket.yes_price <= PAYOFF_YES_MAX_ASK + 1e-12 ? "yes" : "skip";
    case "underdog": {
      if (yesCost <= UNDERDOG_MAX_COST + 1e-12 && yesCost <= noCost) return "yes";
      if (noCost <= UNDERDOG_MAX_COST + 1e-12 && noCost < yesCost) return "no";
      return "skip";
    }
    case "same_game_underdog": {
      if (ticket.same_game !== true || ticket.same_side !== true) return "skip";
      return decideParlayBook("underdog", ticket);
    }
    case "always_yes":
      return "yes";
    case "always_no":
      return "no";
  }
}

export function sidePnl(
  side: "yes" | "no",
  settlement: 0 | 1,
  yesPrice: number,
  noPrice: number,
  contracts: number,
): number {
  const price = side === "yes" ? yesPrice : noPrice;
  const fee = contracts * kalshiTakerFee(price);
  const raw = side === "yes"
    ? contracts * (settlement - yesPrice) - fee
    : contracts * ((1 - settlement) - noPrice) - fee;
  return round4(raw);
}

export function collectParlayTickets(
  markets: ParlayBacktestMarket[],
  opts?: { contracts?: number },
): ParlayBookTicket[] {
  const contracts = clampContracts(opts?.contracts);
  if (!markets.length) return [];
  const byTicker = groupByTicker(markets);
  const tickets: ParlayBookTicket[] = [];
  for (const [ticker, snaps] of byTicker) {
    if (!snaps.some((row) => parseMveCategory(row.category)) && !snaps.some((row) => isKalshiParlayFillSource(row.source))) {
      continue;
    }
    const fillRow = snaps.find((row) => isKalshiParlayFillSource(row.source));
    const rfqRow = snaps.find(isRfqTwoWay);
    const combo = snaps.find((row) => parseMveCategory(row.category))
      ?? fillRow
      ?? rfqRow
      ?? null;
    const aligned = combo ? alignLegs(combo, byTicker) : null;
    const settlement = comboSettlement(byTicker, snaps, combo);

    if (fillRow) {
      const built = ticketFromFill(fillRow, aligned, settlement, contracts);
      if (built) tickets.push(built);
    }
    if (rfqRow && rfqRow.market_ticker === ticker) {
      const built = ticketFromRfq(rfqRow, aligned, settlement, contracts);
      if (built) tickets.push(built);
    }
  }
  tickets.sort((a, b) => {
    if (a.universe !== b.universe) return a.universe === "fill" ? -1 : 1;
    return (b.quoted_at || "").localeCompare(a.quoted_at || "");
  });
  return tickets;
}

export function scoreParlayBooks(
  markets: ParlayBacktestMarket[],
  opts?: { contracts?: number; now?: number; errors?: string[] },
): KalshiParlayBooksSnapshot {
  const contracts = clampContracts(opts?.contracts);
  const errors = opts?.errors ?? [];
  const tickets = collectParlayTickets(markets, { contracts });
  const fills = tickets.filter((t) => t.universe === "fill");
  const rfq = tickets.filter((t) => t.universe === "rfq");
  const combined = uniqueTickersPreferFill(tickets);
  const books = PARLAY_BOOKS.map((def) => ({
    ...def,
    fills: scoreBook(def.id, fills, contracts),
    rfq: scoreBook(def.id, rfq, contracts),
    combined: scoreBook(def.id, combined, contracts),
  }));
  const buckets = scoreBuckets(combined);
  const notes = buildNotes(fills, rfq, combined, books);
  const { headline, bullets } = buildVerdict(fills, books);
  return {
    design_id: KALSHI_PARLAY_BOOKS_DESIGN_ID,
    slug: KALSHI_PARLAY_BOOKS_SLUG,
    fetched_at: new Date(opts?.now ?? Date.now()).toISOString(),
    contracts,
    payoff_yes_max_ask: PAYOFF_YES_MAX_ASK,
    underdog_max_cost: UNDERDOG_MAX_COST,
    universes: {
      fills: census(fills),
      rfq: census(rfq),
      combined: census(combined),
    },
    books,
    buckets,
    tickets: combined.slice(0, TICKET_TABLE_LIMIT),
    headline,
    bullets,
    notes,
    errors,
  };
}

export async function runKalshiParlayBooksExperiment(deps: {
  queryKalshiSports: () => Promise<LakeKalshiMarket[]>;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  kalshiBase?: string;
}): Promise<KalshiParlayBooksSnapshot> {
  const errors: string[] = [];
  let sports: LakeKalshiMarket[] = [];
  try {
    sports = await deps.queryKalshiSports();
  } catch (error) {
    errors.push(`sports lake: ${error instanceof Error ? error.message : String(error)}`);
  }
  const markets = sports.map(lakeToBookMarket);
  if (deps.fetchJson && markets.length) {
    try {
      const hydrated = await hydrateParlaySettlements(markets, deps.fetchJson, {
        base: deps.kalshiBase,
      });
      for (const row of hydrated.extra) markets.push(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`settlement hydrate: ${message}`);
    }
  }
  return scoreParlayBooks(markets, { now: deps.now?.(), errors });
}

export function kalshiParlayBooksCacheTtlMs(snapshot: {
  universes: { combined: ParlayUniverseCensus };
  errors: string[];
}): number {
  if (!snapshot.universes.combined.n && snapshot.errors.length) return 90_000;
  return 10 * 60 * 1000;
}

function scoreBook(
  id: ParlayBookId,
  tickets: ParlayBookTicket[],
  contracts: number,
): ParlayBookScore {
  let taken = 0;
  let settled = 0;
  let wins = 0;
  let pnl = 0;
  const prices: number[] = [];
  const rrs: number[] = [];
  const breakevens: number[] = [];
  for (const ticket of tickets) {
    const side = decideParlayBook(id, ticket);
    if (side === "skip") continue;
    taken += 1;
    const price = side === "yes" ? ticket.yes_price : ticket.no_price;
    prices.push(price);
    const rr = rewardRisk(price);
    if (rr != null) rrs.push(rr);
    breakevens.push(costWithFee(price));
    if (ticket.settlement !== 0 && ticket.settlement !== 1) continue;
    settled += 1;
    const won = side === "yes" ? ticket.settlement === 1 : ticket.settlement === 0;
    if (won) wins += 1;
    pnl += sidePnl(side, ticket.settlement, ticket.yes_price, ticket.no_price, ticket.contracts || contracts);
  }
  return {
    taken,
    settled,
    wins,
    hit_rate: settled ? wins / settled : null,
    pnl: round4(pnl),
    avg_price: mean(prices),
    avg_rr: mean(rrs),
    breakeven: mean(breakevens),
  };
}

function scoreBuckets(tickets: ParlayBookTicket[]): ParlayPayoffBucket[] {
  const settled = tickets.filter((t) => t.settlement === 0 || t.settlement === 1);
  return PAYOFF_BUCKETS.map((bin) => {
    const rows = settled.filter((t) => t.yes_price >= bin.lo && t.yes_price < bin.hi);
    const hits = rows.filter((t) => t.settlement === 1).length;
    const yesPnls = rows.map((t) => sidePnl("yes", t.settlement as 0 | 1, t.yes_price, t.no_price, t.contracts));
    const noPnls = rows.map((t) => sidePnl("no", t.settlement as 0 | 1, t.yes_price, t.no_price, t.contracts));
    const wins = yesPnls.filter((n) => n > 0);
    const losses = yesPnls.filter((n) => n < 0);
    const avgWin = mean(wins);
    const avgLoss = mean(losses.map((n) => Math.abs(n)));
    return {
      lo: bin.lo,
      hi: bin.hi,
      label: bin.label,
      n: rows.length,
      hits,
      hit_rate: rows.length ? hits / rows.length : null,
      avg_yes: mean(rows.map((t) => t.yes_price)),
      breakeven: mean(rows.map((t) => costWithFee(t.yes_price))),
      yes_pnl: round4(yesPnls.reduce((a, b) => a + b, 0)),
      no_pnl: round4(noPnls.reduce((a, b) => a + b, 0)),
      avg_yes_win: avgWin,
      avg_yes_loss: avgLoss,
      yes_rr: avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null,
    };
  });
}

function buildVerdict(
  fills: ParlayBookTicket[],
  books: ParlayBookResult[],
): { headline: string; bullets: string[] } {
  const settledFills = fills.filter((t) => t.settlement === 0 || t.settlement === 1);
  const byId = Object.fromEntries(books.map((b) => [b.id, b])) as Record<ParlayBookId, ParlayBookResult>;
  const underdog = byId.underdog.fills;
  const corr = byId.corr_room_yes.fills;
  const payoff = byId.payoff_yes.fills;
  const alwaysNo = byId.always_no.fills;
  const alwaysYes = byId.always_yes.fills;
  const sameGame = byId.same_game_underdog.fills;
  const candidates: ParlayBookResult[] = books.filter((b) =>
    b.id === "underdog" || b.id === "payoff_yes" || b.id === "same_game_underdog" || b.id === "corr_room_yes"
  );
  const ranked = candidates.slice().sort((a, b) => b.fills.pnl - a.fills.pnl || b.fills.settled - a.fills.settled);
  const winner = ranked[0] ?? byId.underdog;

  let headline: string;
  if (!settledFills.length) {
    headline = corr.taken
      ? `Corr-room YES would take ${corr.taken} RFQ${corr.taken === 1 ? "" : "s"} this window; no live fills have settled yet.`
      : "No settled live fills yet — corr-room YES is still the live filter, and the payoff books have nothing to grade.";
  } else {
    const verb = winner.fills.pnl >= 0 ? "made" : "lost";
    headline =
      `On last night's ${settledFills.length} live fill${settledFills.length === 1 ? "" : "s"}, ${winner.name} ${verb} $${Math.abs(winner.fills.pnl).toFixed(2)}.`
      + ` Corr-room YES took ${corr.taken} ticket${corr.taken === 1 ? "" : "s"}`
      + ` (${fmtSigned(corr.pnl)}). Always-NO ${alwaysNo.pnl >= 0 ? "made" : "lost"} $${Math.abs(alwaysNo.pnl).toFixed(2)}.`;
  }

  const bullets: string[] = [];
  if (settledFills.length) {
    bullets.push(
      `Underdog side (buy the ≤ 50¢ claim) ${fmtSigned(underdog.pnl)} on ${underdog.settled} tickets; `
      + `always YES ${fmtSigned(alwaysYes.pnl)} — they match when every combo YES is the cheap side.`,
    );
    bullets.push(
      `Payoff YES (ask ≤ 30¢) ${fmtSigned(payoff.pnl)} on ${payoff.settled} of ${settledFills.length} fills. `
      + `A tighter ask cap is not automatically better — last night's YES hits included 35–42¢ quotes.`,
    );
    bullets.push(
      `Always-NO ${fmtSigned(alwaysNo.pnl)} despite a high filled-side hit rate: expensive NO is 1:4 reward-to-risk.`,
    );
  }
  bullets.push(
    `Corr-room YES is a pricing-edge filter (independence on correlated legs). It took ${corr.taken} fill`
    + `${corr.taken === 1 ? "" : "s"} this window. Same-game underdog took ${sameGame.taken}.`,
  );
  bullets.push(
    "These notebooks do not turn LIVE on. The executor still sends accepted_side=yes; last night filled BUY NO.",
  );
  return { headline, bullets };
}

function buildNotes(
  fills: ParlayBookTicket[],
  rfq: ParlayBookTicket[],
  combined: ParlayBookTicket[],
  books: ParlayBookResult[],
): string[] {
  const notes: string[] = [
    "P&L is 10-contract Kalshi taker-fee adjusted. Fill tickets use the portfolio price; RFQ tickets buy YES at the ask and NO at 1 − bid.",
    "Combined universe is one ticket per ticker (fill wins over RFQ) so a combo is not counted twice.",
  ];
  if (!fills.length) {
    notes.push("No source=kalshi_parlay_fill rows yet — live-fill scores stay at zero until the executor publishes the portfolio tape.");
  }
  if (rfq.length && !rfq.some((t) => t.settlement != null)) {
    notes.push("RFQ two-ways are in the lake but have not settled — RFQ book P&L waits on source=kalshi_settlement.");
  }
  if (combined.length && books.find((b) => b.id === "same_game_underdog")?.combined.taken === 0) {
    notes.push("Same-game underdog needs aligned legs on the combo (category mve|…). Tickets without p,q are skipped by that book and by corr-room.");
  }
  return notes;
}

function ticketFromFill(
  row: ParlayBacktestMarket,
  aligned: AlignedLegs | null,
  settlement: 0 | 1 | null,
  contracts: number,
): ParlayBookTicket | null {
  const yes = row.yes_bid;
  const no = row.no_bid ?? (yes != null ? 1 - yes : null);
  if (yes == null || no == null || !(yes > 0) || !(no > 0)) return null;
  const size = row.volume != null && row.volume > 0 ? row.volume : contracts;
  return finishTicket({
    market_ticker: row.market_ticker,
    title: row.title,
    quoted_at: row.fetched_at ?? null,
    universe: "fill",
    yes_price: yes,
    no_price: no,
    contracts: size,
    settlement,
    aligned,
    yes_bid: yes,
    yes_ask: yes,
  });
}

function ticketFromRfq(
  row: ParlayBacktestMarket,
  aligned: AlignedLegs | null,
  settlement: 0 | 1 | null,
  contracts: number,
): ParlayBookTicket | null {
  const yesAsk = row.yes_ask;
  const yesBid = row.yes_bid;
  if (yesAsk == null || yesBid == null) return null;
  return finishTicket({
    market_ticker: row.market_ticker,
    title: row.title,
    quoted_at: row.fetched_at ?? null,
    universe: "rfq",
    yes_price: yesAsk,
    no_price: 1 - yesBid,
    contracts,
    settlement,
    aligned,
    yes_bid: yesBid,
    yes_ask: yesAsk,
  });
}

function finishTicket(input: {
  market_ticker: string;
  title: string;
  quoted_at: string | null;
  universe: ParlayTicketUniverse;
  yes_price: number;
  no_price: number;
  contracts: number;
  settlement: 0 | 1 | null;
  aligned: AlignedLegs | null;
  yes_bid: number;
  yes_ask: number;
}): ParlayBookTicket {
  const aligned = input.aligned;
  const decision = aligned
    ? evaluateParlayQuote({
      market_ticker: input.market_ticker,
      same_game: aligned.same_game,
      sides: aligned.sides,
      p: aligned.p,
      q: aligned.q,
      yes_bid: input.yes_bid,
      yes_ask: input.yes_ask,
      quote_id: input.universe === "rfq" ? "lake_rfq" : "lake_fill",
    })
    : null;
  return {
    market_ticker: input.market_ticker,
    title: input.title,
    quoted_at: input.quoted_at,
    universe: input.universe,
    yes_price: input.yes_price,
    no_price: input.no_price,
    contracts: input.contracts,
    p: aligned?.p ?? null,
    q: aligned?.q ?? null,
    same_game: aligned?.same_game ?? null,
    same_side: aligned?.same_side ?? null,
    corr_room: decision?.corr_room ?? null,
    independence: decision?.independence ?? null,
    phi: decision?.phi ?? null,
    corr_room_ok: decision?.ok ?? false,
    settlement: input.settlement,
  };
}

interface AlignedLegs {
  p: number;
  q: number;
  sides: Array<"yes" | "no">;
  same_game: boolean;
  same_side: boolean;
}

function alignLegs(
  combo: ParlayBacktestMarket,
  byTicker: Map<string, ParlayBacktestMarket[]>,
): AlignedLegs | null {
  const parsed = parseMveCategory(combo.category);
  if (!parsed || parsed.legs.length !== 2) return null;
  const atMs = fetchedMs(combo);
  const sides: Array<"yes" | "no"> = [];
  const games: string[] = [];
  const probs: number[] = [];
  for (const spec of parsed.legs) {
    const legRow = nearestTradable(byTicker.get(spec.market_ticker) ?? [], atMs);
    if (!legRow) return null;
    let prob = quoteMid(legRow);
    if (prob != null && spec.side === "no") prob = 1 - prob;
    if (prob == null || !hasTradableQuote(legRow)) return null;
    sides.push(spec.side);
    probs.push(prob);
    games.push(sportsGameKey(spec.market_ticker, spec.event_ticker || legRow.event_ticker));
  }
  if (probs.length !== 2) return null;
  return {
    p: probs[0]!,
    q: probs[1]!,
    sides,
    same_game: parlayGameGroup(games) === "same_game",
    same_side: legsSameSide(sides),
  };
}

function comboSettlement(
  byTicker: Map<string, ParlayBacktestMarket[]>,
  snaps: ParlayBacktestMarket[],
  combo: ParlayBacktestMarket | null,
): 0 | 1 | null {
  const direct = tickerSettlement(snaps);
  if (direct === 0 || direct === 1) return direct;
  const parsed = parseMveCategory(combo?.category);
  if (!parsed) return null;
  return inferComboSettlement(parsed.legs.map((spec) => ({
    side: spec.side,
    settlement: tickerSettlement(byTicker.get(spec.market_ticker) ?? []),
  })));
}

function uniqueTickersPreferFill(tickets: ParlayBookTicket[]): ParlayBookTicket[] {
  const best = new Map<string, ParlayBookTicket>();
  for (const ticket of tickets) {
    const prior = best.get(ticket.market_ticker);
    if (!prior || (ticket.universe === "fill" && prior.universe !== "fill")) {
      best.set(ticket.market_ticker, ticket);
    }
  }
  return [...best.values()].sort((a, b) => (b.quoted_at || "").localeCompare(a.quoted_at || ""));
}

function census(tickets: ParlayBookTicket[]): ParlayUniverseCensus {
  return {
    n: tickets.length,
    settled: tickets.filter((t) => t.settlement === 0 || t.settlement === 1).length,
  };
}

function lakeToBookMarket(row: LakeKalshiMarket): ParlayBacktestMarket {
  return {
    market_ticker: row.market_ticker,
    event_ticker: row.event_ticker,
    title: row.title,
    category: row.category,
    status: row.status,
    yes_bid: row.yes_bid,
    yes_ask: row.yes_ask,
    yes_last: row.yes_last,
    no_bid: row.no_bid,
    volume: row.volume,
    liquidity: row.liquidity,
    yes_subtitle: row.yes_subtitle,
    close_time: row.close_time,
    fetched_at: row.fetched_at,
    source: row.source,
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

function fetchedMs(row: ParlayBacktestMarket): number {
  if (!row.fetched_at) return 0;
  const t = Date.parse(row.fetched_at);
  return Number.isFinite(t) ? t : 0;
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

function nearestTradable(snaps: ParlayBacktestMarket[], atMs: number): ParlayBacktestMarket | null {
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

function clampContracts(raw?: number): number {
  if (!raw || raw <= 0) return PARLAY_MAX_CONTRACTS;
  return Math.min(PARLAY_MAX_CONTRACTS, Math.floor(raw));
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function fmtSigned(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
