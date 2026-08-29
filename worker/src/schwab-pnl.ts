/**
 * Realized trading PnL time series from Schwab TRADE history.
 *
 * Builds a FIFO lot ledger from normalized trades, then a cumulative series for
 * chart presets (MTD / YTD / 1M / … / 1Y). Period P&L only includes lots that
 * were opened on or after the chart start — closes of older lots are reported
 * separately as prior_open_pnl so pre-period drawdowns are not dumped into the
 * selected window. Not an account equity curve (no deposits / open MTM).
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";
import {
  listSchwabAccountNumbers,
  listSchwabTransactions,
  normalizeTrade,
  toTradeAccounts,
  type SchwabRawTransaction,
  type SchwabTrade,
  SCHWAB_TRADES_MAX_RANGE_DAYS,
} from "./schwab-trader";
import { SchwabApiError } from "./schwab-portfolio";

export type SchwabPnlRange = "MTD" | "YTD" | "1M" | "3M" | "6M" | "1Y";

export const SCHWAB_PNL_RANGES: SchwabPnlRange[] = [
  "MTD",
  "YTD",
  "1M",
  "3M",
  "6M",
  "1Y",
];

export interface SchwabPnlPoint {
  date: string;
  daily_pnl: number;
  cumulative_pnl: number;
}

export interface SchwabPnlFill {
  id: string;
  date: string;
  symbol: string | null;
  description: string | null;
  side: SchwabTrade["side"];
  quantity: number | null;
  price: number | null;
  net_amount: number | null;
  fees: number | null;
  realized_pnl: number;
  opened: string;
  /** True when every closed lot was opened before the chart window. */
  prior_open: boolean;
  asset_type: string | null;
}

export interface SchwabDistribution {
  id: string;
  date: string;
  symbol: string | null;
  description: string | null;
  amount: number | null;
  type: string | null;
  status: string | null;
}

export interface SchwabPnlSummary {
  /** Realized PnL for lots opened on/after the chart start and closed in-window. */
  period_pnl: number;
  /**
   * Realized on closes in-window whose lots were opened before the chart start.
   * Excluded from period_pnl / the chart so pre-period losses are not carried in.
   */
  prior_open_pnl: number;
  /** Net dividends / interest credited in the chart window. */
  distributions_total: number;
  trade_count: number;
  closing_trade_count: number;
  unmatched_close_count: number;
  skipped_trade_count: number;
}

export interface SchwabPnlView {
  accounts: Array<{ id: string; label: string }>;
  account: string | null;
  range: SchwabPnlRange;
  start: string;
  end: string;
  points: SchwabPnlPoint[];
  summary: SchwabPnlSummary;
  /** Closing fills that realized P&L in the chart window (newest first). */
  fills: SchwabPnlFill[];
  /** Dividends / interest in the chart window (newest first). */
  distributions: SchwabDistribution[];
  may_be_truncated: boolean;
}

export type SchwabPnlResult =
  | { ok: true; view: SchwabPnlView }
  | { ok: false; reason: "not_connected" }
  | { ok: false; reason: "bad_request"; message: string }
  | { ok: false; reason: "refresh_failed" | "upstream"; status: number; message: string };

/** America/New_York calendar date as YYYY-MM-DD. */
export function etDateString(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function clampStartToMaxWindow(start: string, end: string): string {
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const minStartMs = endMs - (SCHWAB_TRADES_MAX_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return start;
  if (startMs < minStartMs) {
    return new Date(minStartMs).toISOString().slice(0, 10);
  }
  return start;
}

/** Resolve a preset range to inclusive YYYY-MM-DD bounds (ET calendar). */
export function resolvePnlRange(
  range: string | null,
  now = new Date(),
): { range: SchwabPnlRange; start: string; end: string } | { error: string } {
  const key = (range?.trim().toUpperCase() || "YTD") as SchwabPnlRange;
  if (!SCHWAB_PNL_RANGES.includes(key)) {
    return { error: `range must be one of ${SCHWAB_PNL_RANGES.join(", ")}` };
  }

  const end = etDateString(now);
  let start: string;
  if (key === "YTD") {
    start = `${end.slice(0, 4)}-01-01`;
  } else if (key === "MTD") {
    start = `${end.slice(0, 7)}-01`;
  } else {
    const days = key === "1M" ? 30 : key === "3M" ? 90 : key === "6M" ? 180 : 365;
    const endMs = Date.parse(`${end}T12:00:00.000Z`);
    start = new Date(endMs - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  start = clampStartToMaxWindow(start, end);
  return { range: key, start, end };
}

function tradeDay(trade: SchwabTrade): string | null {
  const raw = trade.trade_date;
  if (!raw) return null;
  return raw.length >= 10 ? raw.slice(0, 10) : null;
}

/** Parsed OCC equity-option symbol (`AAPL  240119C00150000`). */
export type OccOption = {
  root: string;
  /** Underlying ticker (root trimmed). */
  underlying: string;
  /** YYMMDD expiration. */
  expiration: string;
  right: "C" | "P";
  strike: number;
};

/**
 * Parse a Schwab/OCC option symbol. Accepts space-padded roots
 * (`CAR   260618P00390000`) and compact forms.
 */
export function parseOccOptionSymbol(symbol: string | null | undefined): OccOption | null {
  if (!symbol) return null;
  const compact = symbol.toUpperCase().replace(/\s+/g, "");
  const m = /^([A-Z0-9.\-]{1,6})(\d{6})([CP])(\d{8})$/.exec(compact);
  if (!m) return null;
  const strikeRaw = Number(m[4]);
  if (!Number.isFinite(strikeRaw)) return null;
  return {
    root: m[1]!,
    underlying: m[1]!,
    expiration: m[2]!,
    right: m[3] as "C" | "P",
    strike: strikeRaw / 1000,
  };
}

function isEquityLike(trade: SchwabTrade): boolean {
  const at = (trade.asset_type ?? "").toUpperCase();
  if (at === "OPTION") return false;
  if (at === "EQUITY" || at === "COLLECTIVE_INVESTMENT") return true;
  // Fall back: non-OCC symbols are treated as underlyings.
  return parseOccOptionSymbol(trade.symbol) == null && Boolean(trade.symbol);
}

function strikeMatchesDelivery(strike: number, deliveryPrice: number): boolean {
  // Assignment/exercise delivers shares at the option strike (penny tolerance).
  return Math.abs(strike - deliveryPrice) <= 0.051;
}

type OpenShortOption = {
  trade: SchwabTrade;
  occ: OccOption;
  /** Remaining short contracts. */
  qty: number;
};

/**
 * Schwab TRADE history often omits the option close on assignment — only the
 * underlying delivery appears (buy stock at put strike / sell at call strike).
 * Without a synthetic cover, short option premium stays unrealized and the
 * chart dumps the full stock loss (e.g. May 8 CAR put spread).
 *
 * Insert zero-cash buy-to-close (put) or sell-to-close (call) rows immediately
 * before matching equity delivery fills.
 */
export function synthesizeOptionAssignmentCloses(trades: SchwabTrade[]): SchwabTrade[] {
  const chron = [...trades].sort((a, b) => {
    const da = a.trade_date ?? "";
    const db = b.trade_date ?? "";
    if (da !== db) return da.localeCompare(db);
    const ia = a.activity_id ?? 0;
    const ib = b.activity_id ?? 0;
    return ia - ib;
  });

  const openShorts: OpenShortOption[] = [];
  const out: SchwabTrade[] = [];
  let synthSeq = 0;

  const bumpShort = (trade: SchwabTrade, signedContracts: number) => {
    const occ = parseOccOptionSymbol(trade.symbol);
    if (!occ || signedContracts === 0) return;
    if (signedContracts < 0) {
      // Opening / adding short.
      openShorts.push({ trade, occ, qty: Math.abs(signedContracts) });
      return;
    }
    // Covering short (buy put / buy call to close).
    let left = signedContracts;
    for (const lot of openShorts) {
      if (left <= 1e-12) break;
      if (lot.qty <= 1e-12) continue;
      if (lot.occ.root !== occ.root || lot.occ.right !== occ.right) continue;
      if (lot.occ.expiration !== occ.expiration) continue;
      if (Math.abs(lot.occ.strike - occ.strike) > 0.0005) continue;
      const take = Math.min(lot.qty, left);
      lot.qty -= take;
      left -= take;
    }
  };

  for (const trade of chron) {
    const occ = parseOccOptionSymbol(trade.symbol);
    const qty = absQty(trade);
    const day = tradeDay(trade);

    if (isEquityLike(trade) && qty != null && day && trade.side !== "unknown") {
      const deliveryPrice =
        trade.price != null && Number.isFinite(trade.price)
          ? Math.abs(trade.price)
          : trade.net_amount != null && qty > 0
            ? Math.abs(trade.net_amount) / qty
            : null;
      const contracts = qty / 100;
      const isRoundContracts = Math.abs(contracts - Math.round(contracts)) < 1e-9 && contracts >= 1;

      if (deliveryPrice != null && isRoundContracts) {
        const need = Math.round(contracts);
        let remaining = need;

        // Short put assignment → buy underlying at strike.
        if (trade.side === "buy") {
          for (const lot of openShorts) {
            if (remaining <= 0) break;
            if (lot.qty <= 1e-12) continue;
            if (lot.occ.right !== "P") continue;
            const und = (trade.symbol ?? "").toUpperCase();
            if (lot.occ.underlying !== und) continue;
            if (!strikeMatchesDelivery(lot.occ.strike, deliveryPrice)) continue;

            const take = Math.min(lot.qty, remaining);
            synthSeq += 1;
            const activityId =
              trade.activity_id != null ? trade.activity_id - synthSeq : null;
            out.push({
              id: `synth-assign-${trade.id}-${lot.trade.id}-${synthSeq}`,
              activity_id: activityId,
              trade_date: trade.trade_date,
              settlement_date: trade.settlement_date,
              description: `Option assignment close (${lot.trade.symbol})`,
              status: "VALID",
              activity_type: "ASSIGNMENT",
              net_amount: 0,
              symbol: lot.trade.symbol,
              underlying: lot.occ.underlying,
              asset_type: "OPTION",
              quantity: take,
              price: 0,
              cost: 0,
              fees: 0,
              side: "buy",
              position_effect: "CLOSING",
              order_id: null,
              position_id: null,
            });
            lot.qty -= take;
            remaining -= take;
          }
        }

        // Short call assignment → sell underlying at strike; cover the short call.
        if (trade.side === "sell") {
          for (const lot of openShorts) {
            if (remaining <= 0) break;
            if (lot.qty <= 1e-12) continue;
            if (lot.occ.right !== "C") continue;
            const und = (trade.symbol ?? "").toUpperCase();
            if (lot.occ.underlying !== und) continue;
            if (!strikeMatchesDelivery(lot.occ.strike, deliveryPrice)) continue;

            const take = Math.min(lot.qty, remaining);
            synthSeq += 1;
            const activityId =
              trade.activity_id != null ? trade.activity_id - synthSeq : null;
            out.push({
              id: `synth-assign-${trade.id}-${lot.trade.id}-${synthSeq}`,
              activity_id: activityId,
              trade_date: trade.trade_date,
              settlement_date: trade.settlement_date,
              description: `Option assignment close (${lot.trade.symbol})`,
              status: "VALID",
              activity_type: "ASSIGNMENT",
              net_amount: 0,
              symbol: lot.trade.symbol,
              underlying: lot.occ.underlying,
              asset_type: "OPTION",
              quantity: take,
              price: 0,
              cost: 0,
              fees: 0,
              side: "buy",
              position_effect: "CLOSING",
              order_id: null,
              position_id: null,
            });
            lot.qty -= take;
            remaining -= take;
          }
        }
      }
    }

    out.push(trade);

    if (occ && qty != null && trade.side !== "unknown") {
      const effect = (trade.position_effect ?? "").toUpperCase();
      if (trade.side === "sell" && effect !== "CLOSING") {
        // Opening (or unknown) short sale — track for later assignment.
        bumpShort(trade, -qty);
      } else if (trade.side === "buy" && effect === "CLOSING") {
        bumpShort(trade, qty);
      } else if (trade.side === "buy" && effect !== "OPENING") {
        // Unknown effect buy may be a cover.
        bumpShort(trade, qty);
      }
      // SELL+CLOSING closes a long — ignore for short inventory.
      // BUY+OPENING opens a long — ignore.
    }
  }

  return out;
}

function lotKey(trade: SchwabTrade): string {
  // Prefer symbol over position_id — Schwab often assigns different position
  // ids on open vs close, which would orphan closes and zero out period PnL.
  if (trade.symbol) return `sym:${trade.symbol}`;
  if (trade.underlying) return `und:${trade.underlying}`;
  if (trade.position_id != null) return `pos:${trade.position_id}`;
  return `tx:${trade.id}`;
}

function absQty(trade: SchwabTrade): number | null {
  if (trade.quantity == null || !Number.isFinite(trade.quantity) || trade.quantity === 0) {
    return null;
  }
  return Math.abs(trade.quantity);
}

function tradeCash(trade: SchwabTrade): number | null {
  if (trade.net_amount != null && Number.isFinite(trade.net_amount)) return trade.net_amount;
  if (trade.cost != null && Number.isFinite(trade.cost)) {
    const fees = trade.fees != null && Number.isFinite(trade.fees) ? trade.fees : 0;
    return trade.cost + fees;
  }
  return null;
}

interface Lot {
  /** Always positive remaining size. */
  qty: number;
  /** Absolute dollars tied to the open (paid for long, received for short). */
  costTotal: number;
  direction: "long" | "short";
  /** YYYY-MM-DD the tranche was opened. */
  opened: string;
}

export interface RealizedEvent {
  /** Close / realization day. */
  day: string;
  /** Lot open day (FIFO tranche). */
  opened: string;
  amount: number;
  trade: SchwabTrade;
  closed_qty: number;
}

export interface RealizedPnlLedger {
  events: RealizedEvent[];
  tradeCount: number;
  closingTradeCount: number;
  unmatchedCloseCount: number;
  skippedTradeCount: number;
  /** Trade calendar days seen (for window-scoped counts). */
  tradeDays: string[];
  closingDays: string[];
}

/**
 * FIFO realized PnL from chronological trades.
 * Opens add lots (not merged — preserves open dates); opposite-side fills
 * close lots and emit realized events.
 */
export function buildRealizedPnlLedger(trades: SchwabTrade[]): RealizedPnlLedger {
  const chron = synthesizeOptionAssignmentCloses(trades);

  const books = new Map<string, Lot[]>();
  const events: RealizedEvent[] = [];
  const tradeDays: string[] = [];
  const closingDays: string[] = [];
  let tradeCount = 0;
  let closingTradeCount = 0;
  let unmatchedCloseCount = 0;
  let skippedTradeCount = 0;

  for (const trade of chron) {
    const day = tradeDay(trade);
    const qty = absQty(trade);
    const cash = tradeCash(trade);
    if (!day || qty == null || cash == null || trade.side === "unknown") {
      skippedTradeCount += 1;
      continue;
    }
    tradeCount += 1;
    tradeDays.push(day);

    const effect = (trade.position_effect ?? "").toUpperCase();
    const signed = trade.side === "buy" ? qty : -qty;
    const key = lotKey(trade);
    let lots = books.get(key);
    if (!lots) {
      lots = [];
      books.set(key, lots);
    }

    let remaining = signed;
    let cashLeft = cash;
    let closedQtyTotal = 0;

    while (remaining !== 0 && lots.length > 0) {
      const head = lots[0]!;
      const headSigned = head.direction === "long" ? head.qty : -head.qty;
      if (Math.sign(headSigned) === Math.sign(remaining)) break;

      const closeQty = Math.min(Math.abs(remaining), head.qty);
      const tradeAbs = Math.abs(signed);
      const closeCash = cash * (closeQty / tradeAbs);
      const closeBasis = head.costTotal * (closeQty / head.qty);

      const realized =
        head.direction === "long"
          ? closeCash - closeBasis
          : closeBasis + closeCash;
      events.push({
        day,
        opened: head.opened,
        amount: realized,
        trade,
        closed_qty: closeQty,
      });
      closedQtyTotal += closeQty;

      head.qty -= closeQty;
      head.costTotal -= closeBasis;
      cashLeft -= closeCash;
      remaining += head.direction === "long" ? closeQty : -closeQty;

      if (head.qty <= 1e-12) lots.shift();
    }

    if (closedQtyTotal > 0) {
      closingTradeCount += 1;
      closingDays.push(day);
    }

    const rem = Math.abs(remaining);
    if (rem <= 1e-12) {
      if (Math.abs(cashLeft) > 1e-6) {
        events.push({
          day,
          opened: day,
          amount: cashLeft,
          trade,
          closed_qty: 0,
        });
      }
      continue;
    }

    if (effect === "CLOSING") {
      unmatchedCloseCount += 1;
      continue;
    }

    const direction: "long" | "short" = remaining > 0 ? "long" : "short";
    const costTotal = Math.abs(direction === "long" ? -cashLeft : cashLeft);
    // Do not merge tranches — each open keeps its own date for period attribution.
    lots.push({ qty: rem, costTotal, direction, opened: day });
  }

  return {
    events,
    tradeCount,
    closingTradeCount,
    unmatchedCloseCount,
    skippedTradeCount,
    tradeDays,
    closingDays,
  };
}

/**
 * Sparse daily points + cumulative series between start/end (inclusive).
 * Only lots opened on/after `start` contribute to the chart / period_pnl.
 */
export function seriesFromLedger(
  ledger: RealizedPnlLedger,
  start: string,
  end: string,
): { points: SchwabPnlPoint[]; summary: Omit<SchwabPnlSummary, "distributions_total"> } {
  const daily = new Map<string, number>();
  let period = 0;
  let priorOpen = 0;

  for (const e of ledger.events) {
    if (e.day < start || e.day > end) continue;
    if (e.opened >= start) {
      period += e.amount;
      daily.set(e.day, (daily.get(e.day) ?? 0) + e.amount);
    } else {
      priorOpen += e.amount;
    }
  }

  const activeDays = [...daily.keys()].sort();
  const pointDays = new Set<string>([start, end, ...activeDays]);
  const ordered = [...pointDays].sort();

  let cumulative = 0;
  const points: SchwabPnlPoint[] = [];
  for (const date of ordered) {
    const dayPnl = daily.get(date) ?? 0;
    cumulative += dayPnl;
    points.push({
      date,
      daily_pnl: round2(dayPnl),
      cumulative_pnl: round2(cumulative),
    });
  }

  const tradeCount = ledger.tradeDays.filter((d) => d >= start && d <= end).length;
  const closingTradeCount = ledger.closingDays.filter((d) => d >= start && d <= end).length;

  return {
    points,
    summary: {
      period_pnl: round2(period),
      prior_open_pnl: round2(priorOpen),
      trade_count: tradeCount,
      closing_trade_count: closingTradeCount,
      unmatched_close_count: ledger.unmatchedCloseCount,
      skipped_trade_count: ledger.skippedTradeCount,
    },
  };
}

/** Aggregate FIFO events into one row per closing trade in the chart window. */
export function buildPnlFills(
  ledger: RealizedPnlLedger,
  start: string,
  end: string,
): SchwabPnlFill[] {
  type Agg = {
    trade: SchwabTrade;
    date: string;
    realized: number;
    closedQty: number;
    anyPrior: boolean;
    anyPeriod: boolean;
    earliestOpened: string;
  };
  const byTrade = new Map<string, Agg>();

  for (const e of ledger.events) {
    if (e.day < start || e.day > end) continue;
    const t = e.trade;
    const id = t.id || `${e.day}:${t.symbol ?? "?"}:${t.side}`;
    let agg = byTrade.get(id);
    if (!agg) {
      agg = {
        trade: t,
        date: e.day,
        realized: 0,
        closedQty: 0,
        anyPrior: false,
        anyPeriod: false,
        earliestOpened: e.opened,
      };
      byTrade.set(id, agg);
    }
    agg.realized += e.amount;
    agg.closedQty += e.closed_qty;
    if (e.opened < start) agg.anyPrior = true;
    else agg.anyPeriod = true;
    if (e.opened < agg.earliestOpened) agg.earliestOpened = e.opened;
  }

  const fills: SchwabPnlFill[] = [...byTrade.values()].map((agg) => {
    const t = agg.trade;
    // Prefer period attribution when a fill closes both prior and new lots.
    const priorOpen = agg.anyPrior && !agg.anyPeriod;
    return {
      id: t.id,
      date: agg.date,
      symbol: t.symbol,
      description: t.description,
      side: t.side,
      quantity: agg.closedQty > 0 ? round4(agg.closedQty) : t.quantity != null ? Math.abs(t.quantity) : null,
      price: t.price,
      net_amount: t.net_amount,
      fees: t.fees,
      realized_pnl: round2(agg.realized),
      opened: agg.earliestOpened,
      prior_open: priorOpen,
      asset_type: t.asset_type,
    };
  });

  fills.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.id.localeCompare(a.id);
  });
  return fills;
}

export function normalizeSchwabDistribution(tx: SchwabRawTransaction): SchwabDistribution | null {
  const time =
    (typeof tx.time === "string" && tx.time) ||
    (typeof tx.tradeDate === "string" && tx.tradeDate) ||
    (typeof tx.settlementDate === "string" && tx.settlementDate) ||
    null;
  const date = time && /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(0, 10) : "";
  if (!date) return null;

  const items = Array.isArray(tx.transferItems) ? tx.transferItems : [];
  let amount: number | null = null;
  let symbol: string | null = null;
  let description: string | null =
    typeof tx.description === "string" ? tx.description : null;

  for (const item of items) {
    const inst = item.instrument;
    const asset = (inst?.assetType ?? inst?.type ?? "").toUpperCase();
    const sym = (inst?.symbol ?? "").toUpperCase();
    const isCurrency =
      Boolean(item.feeType) ||
      asset === "CURRENCY" ||
      sym === "USD" ||
      sym.startsWith("CURRENCY_");
    const amt = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : null;

    if (isCurrency) {
      if (amt != null) amount = (amount ?? 0) + amt;
      continue;
    }
    if (inst?.symbol?.trim()) symbol = inst.symbol.trim().toUpperCase();
    if (!description && typeof inst?.description === "string") {
      description = inst.description;
    }
  }

  if (amount == null && typeof tx.netAmount === "number" && Number.isFinite(tx.netAmount)) {
    amount = tx.netAmount;
  }

  const activityId = typeof tx.activityId === "number" ? tx.activityId : null;
  return {
    id: activityId != null ? `dist-${activityId}` : `dist-${date}-${symbol ?? "x"}-${amount ?? 0}`,
    date,
    symbol,
    description,
    amount: amount != null ? round2(amount) : null,
    type: typeof tx.type === "string" ? tx.type : null,
    status: typeof tx.status === "string" ? tx.status : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function emptySummary(): SchwabPnlSummary {
  return {
    period_pnl: 0,
    prior_open_pnl: 0,
    distributions_total: 0,
    trade_count: 0,
    closing_trade_count: 0,
    unmatched_close_count: 0,
    skipped_trade_count: 0,
  };
}

/**
 * Fetch trades for the range, extending lookback toward the Schwab ~1y cap
 * so FIFO can recover cost basis for positions opened before the chart window.
 * Uses 365 inclusive days (not 366) — Schwab rejects the longer bound on some accounts.
 */
export function fetchWindowForPnl(_chartStart: string, chartEnd: string): { start: string; end: string } {
  const endMs = Date.parse(`${chartEnd}T00:00:00.000Z`);
  const lookbackDays = Math.min(SCHWAB_TRADES_MAX_RANGE_DAYS, 365);
  const maxStartMs = endMs - (lookbackDays - 1) * 24 * 60 * 60 * 1000;
  return { start: new Date(maxStartMs).toISOString().slice(0, 10), end: chartEnd };
}

export async function loadSchwabPnl(
  env: SchwabEnv,
  userId: string,
  opts: { range: SchwabPnlRange; start: string; end: string; accountId?: string | null },
  now = Date.now(),
): Promise<SchwabPnlResult> {
  let token: { accessToken: string; tokenType: string } | null;
  try {
    token = await getValidAccessToken(env, userId, now);
  } catch (e) {
    return {
      ok: false,
      reason: "refresh_failed",
      status: 401,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!token) return { ok: false, reason: "not_connected" };

  try {
    const accounts = toTradeAccounts(await listSchwabAccountNumbers(token.accessToken, token.tokenType));
    const publicAccounts = accounts.map((a) => ({ id: a.id, label: a.label }));
    if (accounts.length === 0) {
      return {
        ok: true,
        view: {
          accounts: [],
          account: null,
          range: opts.range,
          start: opts.start,
          end: opts.end,
          points: [
            { date: opts.start, daily_pnl: 0, cumulative_pnl: 0 },
            { date: opts.end, daily_pnl: 0, cumulative_pnl: 0 },
          ],
          summary: emptySummary(),
          fills: [],
          distributions: [],
          may_be_truncated: false,
        },
      };
    }

    let selected = accounts[0]!;
    if (opts.accountId?.trim()) {
      const match = accounts.find((a) => a.id === opts.accountId!.trim());
      if (!match) return { ok: false, reason: "bad_request", message: "unknown Schwab account" };
      selected = match;
    }

    const fetchBounds = fetchWindowForPnl(opts.start, opts.end);
    let raw: Awaited<ReturnType<typeof listSchwabTransactions>>;
    try {
      raw = await listSchwabTransactions(
        token.accessToken,
        selected.hash,
        {
          start: fetchBounds.start,
          end: fetchBounds.end,
          types: "TRADE",
        },
        token.tokenType,
      );
    } catch (e) {
      if (
        e instanceof SchwabApiError &&
        (e.status === 400 || e.status === 404) &&
        (fetchBounds.start < opts.start || fetchBounds.end !== opts.end)
      ) {
        console.error("schwab pnl: lookback fetch failed, retrying chart window", {
          status: e.status,
          detail: e.message.slice(0, 300),
          lookback: fetchBounds,
          chart: { start: opts.start, end: opts.end },
        });
        raw = await listSchwabTransactions(
          token.accessToken,
          selected.hash,
          {
            start: opts.start,
            end: opts.end,
            types: "TRADE",
          },
          token.tokenType,
        );
      } else {
        throw e;
      }
    }
    const trades = raw.map(normalizeTrade);
    const ledger = buildRealizedPnlLedger(trades);
    const { points, summary } = seriesFromLedger(ledger, opts.start, opts.end);
    const fills = buildPnlFills(ledger, opts.start, opts.end);

    let distRaw: SchwabRawTransaction[] = [];
    try {
      distRaw = await listSchwabTransactions(
        token.accessToken,
        selected.hash,
        {
          start: opts.start,
          end: opts.end,
          types: "DIVIDEND_OR_INTEREST",
        },
        token.tokenType,
      );
    } catch (e) {
      console.error("schwab pnl: dividend fetch failed", {
        status: e instanceof SchwabApiError ? e.status : null,
        detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
        range: opts.range,
        start: opts.start,
        end: opts.end,
      });
    }

    const distributions = distRaw
      .map(normalizeSchwabDistribution)
      .filter((d): d is SchwabDistribution => d != null)
      .filter((d) => d.date >= opts.start && d.date <= opts.end)
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const distributionsTotal = round2(
      distributions.reduce((s, d) => s + (d.amount ?? 0), 0),
    );

    return {
      ok: true,
      view: {
        accounts: publicAccounts,
        account: selected.id,
        range: opts.range,
        start: opts.start,
        end: opts.end,
        points,
        summary: {
          ...summary,
          distributions_total: distributionsTotal,
        },
        fills,
        distributions,
        may_be_truncated: trades.length >= 3000,
      },
    };
  } catch (e) {
    if (e instanceof SchwabApiError) {
      console.error("schwab pnl upstream", {
        status: e.status,
        detail: e.message.slice(0, 500),
        range: opts.range,
        start: opts.start,
        end: opts.end,
        accountId: opts.accountId ?? null,
      });
      return { ok: false, reason: "upstream", status: e.status, message: e.message };
    }
    console.error("schwab pnl failed", e);
    return {
      ok: false,
      reason: "upstream",
      status: 502,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
