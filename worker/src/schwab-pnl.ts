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
  etDateString,
  etTradeDay,
  listSchwabAccountNumbers,
  listSchwabTransactions,
  commissionPnl,
  matchesTicker,
  normalizeTrade,
  toTradeAccounts,
  type SchwabRawTransaction,
  type SchwabTrade,
  SCHWAB_TRADES_MAX_RANGE_DAYS,
} from "./schwab-trader";

export { etDateString };
import {
  fetchSchwabAccountsRaw,
  normalizeSchwabAccounts,
  SchwabApiError,
} from "./schwab-portfolio";

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
  /** Realized equity closes (fees included in FIFO cash). */
  daily_equity_pnl: number;
  /** Realized option closes, including assignment covers. */
  daily_option_pnl: number;
  /** Commissions / fees on trades dated this day (typically ≤ 0). */
  daily_fees: number;
  daily_equity_fees: number;
  daily_option_fees: number;
  /** Dividends / interest / distributions credited this day. */
  daily_dividends: number;
}

export interface SchwabPnlFill {
  id: string;
  date: string;
  symbol: string | null;
  underlying: string | null;
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
  cusip: string | null;
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
  /** Root ticker when the book is scoped (equity + options on that root). */
  symbol: string | null;
  points: SchwabPnlPoint[];
  summary: SchwabPnlSummary;
  /** Closing fills that realized P&L in the chart window (newest first). */
  fills: SchwabPnlFill[];
  /** Dividends / interest in the chart window (newest first). */
  distributions: SchwabDistribution[];
  /** All TRADE rows in the chart window (opens + closes, newest first). */
  trades: SchwabTrade[];
  /** True when Schwab may have capped the trade page (~3000 rows). */
  may_be_truncated: boolean;
  /**
   * True when the extended cost-basis lookback fetch failed and we fell back to
   * the chart window only — closes of older lots may lack basis.
   */
  lookback_truncated: boolean;
}

export type SchwabPnlResult =
  | { ok: true; view: SchwabPnlView }
  | { ok: false; reason: "not_connected" }
  | { ok: false; reason: "bad_request"; message: string }
  | { ok: false; reason: "refresh_failed" | "upstream"; status: number; message: string };

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
  return etTradeDay(trade.trade_date);
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
 * (`CAR   260618P00390000`), compact forms, and the readable fallback
 * (`CAR 2026-06-18 P 390`) formerly emitted by normalizeTrade.
 */
export function parseOccOptionSymbol(symbol: string | null | undefined): OccOption | null {
  if (!symbol) return null;
  const upper = symbol.toUpperCase().trim();
  const compact = upper.replace(/\s+/g, "");
  const m = /^([A-Z0-9.\-]{1,6})(\d{6})([CP])(\d{8})$/.exec(compact);
  if (m) {
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

  // Readable: `AAPL 2026-09-18 C 150` or `AAPL 2026-09-18 CALL 150.5`
  const readable =
    /^([A-Z0-9.\-]{1,6})\s+(\d{4}-\d{2}-\d{2})\s+(C|P|CALL|PUT)\s+(\d+(?:\.\d+)?)$/.exec(
      upper,
    );
  if (!readable) return null;
  const strike = Number(readable[4]);
  if (!Number.isFinite(strike)) return null;
  const rightRaw = readable[3]!;
  const right: "C" | "P" = rightRaw.startsWith("P") ? "P" : "C";
  const ymd = readable[2]!;
  return {
    root: readable[1]!,
    underlying: readable[1]!,
    expiration: ymd.slice(2, 4) + ymd.slice(5, 7) + ymd.slice(8, 10),
    right,
    strike,
  };
}

/** OCC YYMMDD expiration → `20YY-MM-DD` (equity options are 21st-century). */
export function occExpirationYmd(expiration: string): string | null {
  if (!/^\d{6}$/.test(expiration)) return null;
  return `20${expiration.slice(0, 2)}-${expiration.slice(2, 4)}-${expiration.slice(4, 6)}`;
}

function expirationDistanceMs(occ: OccOption, deliveryDay: string): number {
  const exp = occExpirationYmd(occ.expiration);
  if (!exp) return Number.POSITIVE_INFINITY;
  const a = Date.parse(`${exp}T12:00:00.000Z`);
  const b = Date.parse(`${deliveryDay}T12:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b);
}

export function isOptionTrade(trade: SchwabTrade): boolean {
  if ((trade.asset_type ?? "").toUpperCase() === "OPTION") return true;
  return parseOccOptionSymbol(trade.symbol) != null;
}

function isEquityLike(trade: SchwabTrade): boolean {
  const at = (trade.asset_type ?? "").toUpperCase();
  if (at === "OPTION") return false;
  if (at === "EQUITY" || at === "COLLECTIVE_INVESTMENT") return true;
  // Fall back: non-OCC symbols are treated as underlyings.
  return parseOccOptionSymbol(trade.symbol) == null && Boolean(trade.symbol);
}

function strikeMatchesDelivery(strike: number, deliveryPrice: number): boolean {
  // Assignment delivers shares at the option strike (1¢ tolerance — avoid
  // matching ordinary fills that happen to trade near a short strike).
  return Math.abs(strike - deliveryPrice) <= 0.011;
}

/** Regular equity executions usually say BOUGHT/SOLD; assignment stock legs often do not. */
function looksLikeRegularEquityExecution(trade: SchwabTrade): boolean {
  const d = (trade.description ?? "").toUpperCase();
  if (/\b(ASSIGN|ASGN|ASSIGNMENT)\b/.test(d)) return false;
  return /\b(BOUGHT|SOLD)\b/.test(d);
}

/** Equity delivery from assignment opens a stock position; skip CLOSING stock legs. */
function equityDeliveryCanBeAssignment(trade: SchwabTrade): boolean {
  const effect = (trade.position_effect ?? "").toUpperCase();
  if (effect === "CLOSING") return false;
  if (looksLikeRegularEquityExecution(trade)) return false;
  return true;
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
 * Insert zero-cash buy-to-close rows immediately before matching equity
 * delivery fills (puts and calls).
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

    if (
      isEquityLike(trade) &&
      qty != null &&
      day &&
      trade.side !== "unknown" &&
      equityDeliveryCanBeAssignment(trade)
    ) {
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
        const right: "C" | "P" | null =
          trade.side === "buy" ? "P" : trade.side === "sell" ? "C" : null;
        const und = (trade.symbol ?? "").toUpperCase();

        if (right && und) {
          // Prefer the short whose expiration is closest to the delivery day
          // (typical assignment is the near expiry). Same-expiry lots stay FIFO.
          const ranked = openShorts
            .map((lot, idx) => ({ lot, idx }))
            .filter(({ lot }) => {
              if (lot.qty <= 1e-12) return false;
              if (lot.occ.right !== right) return false;
              if (lot.occ.underlying !== und) return false;
              return strikeMatchesDelivery(lot.occ.strike, deliveryPrice);
            })
            .sort((a, b) => {
              const d =
                expirationDistanceMs(a.lot.occ, day) - expirationDistanceMs(b.lot.occ, day);
              if (d !== 0) return d;
              return a.idx - b.idx;
            });

          let remaining = need;
          for (const { lot } of ranked) {
            if (remaining <= 0) break;
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
              cusip: lot.trade.cusip,
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
  // Canonical OCC key so spaced / compact / readable symbols share one book.
  const occ = parseOccOptionSymbol(trade.symbol);
  if (occ) {
    return `occ:${occ.underlying}:${occ.expiration}:${occ.right}:${occ.strike}`;
  }
  // Prefer symbol over position_id — Schwab often assigns different position
  // ids on open vs close, which would orphan closes and zero out period PnL.
  if (trade.symbol) return `sym:${trade.symbol.toUpperCase()}`;
  if (trade.underlying) return `und:${trade.underlying.toUpperCase()}`;
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
  /** Calendar days of unmatched CLOSING fills (for window-scoped counts). */
  unmatchedCloseDays: string[];
  skippedTradeCount: number;
  /** Calendar days of skipped fills (for window-scoped counts). */
  skippedDays: string[];
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
  const unmatchedCloseDays: string[] = [];
  let skippedTradeCount = 0;
  const skippedDays: string[] = [];

  for (const trade of chron) {
    const day = tradeDay(trade);
    const qty = absQty(trade);
    const cash = tradeCash(trade);
    if (!day || qty == null || cash == null || trade.side === "unknown") {
      skippedTradeCount += 1;
      if (day) skippedDays.push(day);
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
      unmatchedCloseDays.push(day);
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
    unmatchedCloseDays,
    skippedTradeCount,
    skippedDays,
    tradeDays,
    closingDays,
  };
}

/**
 * Sparse daily points + cumulative series between start/end (inclusive).
 * Only lots opened on/after `start` contribute to the chart / period_pnl.
 */
function emptyPoint(date: string): SchwabPnlPoint {
  return {
    date,
    daily_pnl: 0,
    cumulative_pnl: 0,
    daily_equity_pnl: 0,
    daily_option_pnl: 0,
    daily_fees: 0,
    daily_equity_fees: 0,
    daily_option_fees: 0,
    daily_dividends: 0,
  };
}

export function seriesFromLedger(
  ledger: RealizedPnlLedger,
  start: string,
  end: string,
): { points: SchwabPnlPoint[]; summary: Omit<SchwabPnlSummary, "distributions_total"> } {
  const daily = new Map<string, number>();
  const dailyEquity = new Map<string, number>();
  const dailyOption = new Map<string, number>();
  let period = 0;
  let priorOpen = 0;

  for (const e of ledger.events) {
    if (e.day < start || e.day > end) continue;
    if (e.opened >= start) {
      period += e.amount;
      daily.set(e.day, (daily.get(e.day) ?? 0) + e.amount);
      if (isOptionTrade(e.trade)) {
        dailyOption.set(e.day, (dailyOption.get(e.day) ?? 0) + e.amount);
      } else {
        dailyEquity.set(e.day, (dailyEquity.get(e.day) ?? 0) + e.amount);
      }
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
      ...emptyPoint(date),
      daily_pnl: round2(dayPnl),
      cumulative_pnl: round2(cumulative),
      daily_equity_pnl: round2(dailyEquity.get(date) ?? 0),
      daily_option_pnl: round2(dailyOption.get(date) ?? 0),
    });
  }

  const tradeCount = ledger.tradeDays.filter((d) => d >= start && d <= end).length;
  const closingTradeCount = ledger.closingDays.filter((d) => d >= start && d <= end).length;
  const unmatchedCloseCount = ledger.unmatchedCloseDays.filter(
    (d) => d >= start && d <= end,
  ).length;
  const skippedTradeCount = ledger.skippedDays.filter((d) => d >= start && d <= end).length;

  return {
    points,
    summary: {
      period_pnl: round2(period),
      prior_open_pnl: round2(priorOpen),
      trade_count: tradeCount,
      closing_trade_count: closingTradeCount,
      unmatched_close_count: unmatchedCloseCount,
      skipped_trade_count: skippedTradeCount,
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
      underlying: t.underlying,
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
  let cusip: string | null = null;
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
    else if (!symbol && inst?.underlyingSymbol?.trim()) {
      symbol = inst.underlyingSymbol.trim().toUpperCase();
    }
    if (!cusip && inst?.cusip?.trim()) cusip = inst.cusip.trim().toUpperCase();
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
    cusip,
  };
}

function fundNameKey(name: string | null | undefined): string {
  return (name ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * CUSIPs and fund names that belong to `ticker`, from trades/positions that
 * already have a symbol. ETF dividends often omit instrument.symbol and
 * only carry the legal name or CUSIP.
 */
export function aliasesForTicker(
  ticker: string,
  rows: Array<{
    symbol?: string | null;
    underlying?: string | null;
    description?: string | null;
    cusip?: string | null;
  }>,
): { cusips: Set<string>; names: Set<string> } {
  const cusips = new Set<string>();
  const names = new Set<string>();
  for (const row of rows) {
    if (!matchesTicker(row, ticker)) continue;
    const cusip = row.cusip?.trim().toUpperCase();
    if (cusip) cusips.add(cusip);
    const name = fundNameKey(row.description);
    if (name) names.add(name);
  }
  return { cusips, names };
}

export function distributionMatchesTicker(
  dist: { symbol?: string | null; description?: string | null; cusip?: string | null },
  ticker: string | null | undefined,
  aliases: { cusips: Set<string>; names: Set<string> },
): boolean {
  if (!ticker?.trim()) return true;
  if (matchesTicker({ symbol: dist.symbol, underlying: null }, ticker)) return true;
  const cusip = dist.cusip?.trim().toUpperCase();
  if (cusip && aliases.cusips.has(cusip)) return true;
  const name = fundNameKey(dist.description);
  return Boolean(name && aliases.names.has(name));
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

/** Stamp fee / dividend sleeves onto trading points; insert days that only have cash. */
export function attachCashSleeves(
  points: SchwabPnlPoint[],
  trades: SchwabTrade[],
  distributions: SchwabDistribution[],
  start: string,
  end: string,
): SchwabPnlPoint[] {
  const byDate = new Map<string, SchwabPnlPoint>();
  for (const p of points) {
    byDate.set(p.date, { ...p });
  }

  const touch = (date: string): SchwabPnlPoint => {
    let row = byDate.get(date);
    if (!row) {
      row = emptyPoint(date);
      byDate.set(date, row);
    }
    return row;
  };

  for (const trade of trades) {
    const day = tradeDay(trade);
    if (!day || day < start || day > end) continue;
    const fees = commissionPnl(trade.fees);
    if (fees === 0) continue;
    const row = touch(day);
    row.daily_fees = round2(row.daily_fees + fees);
    if (isOptionTrade(trade)) {
      row.daily_option_fees = round2(row.daily_option_fees + fees);
    } else {
      row.daily_equity_fees = round2(row.daily_equity_fees + fees);
    }
  }

  for (const dist of distributions) {
    if (dist.date < start || dist.date > end) continue;
    const amt = dist.amount != null && Number.isFinite(dist.amount) ? dist.amount : 0;
    if (amt === 0) continue;
    const row = touch(dist.date);
    row.daily_dividends = round2(row.daily_dividends + amt);
  }

  const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  let cumulative = 0;
  for (const row of ordered) {
    cumulative += row.daily_pnl;
    row.cumulative_pnl = round2(cumulative);
  }
  return ordered;
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
  opts: {
    range: SchwabPnlRange;
    start: string;
    end: string;
    accountId?: string | null;
    symbol?: string | null;
  },
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

  const ticker = opts.symbol?.trim().toUpperCase() || null;

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
          symbol: ticker,
          points: [
            emptyPoint(opts.start),
            emptyPoint(opts.end),
          ],
          summary: emptySummary(),
          fills: [],
          distributions: [],
          trades: [],
          may_be_truncated: false,
          lookback_truncated: false,
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
    let lookbackTruncated = false;
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
        lookbackTruncated = true;
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
    const allTrades = raw.map(normalizeTrade);
    const trades = allTrades.filter((t) => matchesTicker(t, ticker));
    const ledger = buildRealizedPnlLedger(trades);
    const { points: tradingPoints, summary } = seriesFromLedger(ledger, opts.start, opts.end);
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

    const aliasRows: Array<{
      symbol?: string | null;
      underlying?: string | null;
      description?: string | null;
      cusip?: string | null;
    }> = [...allTrades];
    if (ticker) {
      try {
        const rawAccounts = await fetchSchwabAccountsRaw(token.accessToken, token.tokenType);
        const view = normalizeSchwabAccounts(rawAccounts);
        const acct = view.accounts.find((a) => a.id === selected.id) ?? view.accounts[0];
        for (const p of acct?.positions ?? []) {
          aliasRows.push({
            symbol: p.symbol,
            underlying: p.underlying,
            description: p.description,
            cusip: p.cusip,
          });
        }
      } catch (e) {
        console.error("schwab pnl: position alias fetch failed", {
          status: e instanceof SchwabApiError ? e.status : null,
          detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
        });
      }
    }
    const aliases = ticker
      ? aliasesForTicker(ticker, aliasRows)
      : { cusips: new Set<string>(), names: new Set<string>() };

    const distributions = distRaw
      .map(normalizeSchwabDistribution)
      .filter((d): d is SchwabDistribution => d != null)
      .filter((d) => d.date >= opts.start && d.date <= opts.end)
      .filter((d) => distributionMatchesTicker(d, ticker, aliases))
      .map((d) => (ticker && !d.symbol ? { ...d, symbol: ticker } : d))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const distributionsTotal = round2(
      distributions.reduce((s, d) => s + (d.amount ?? 0), 0),
    );

    const windowTrades = trades
      .filter((t) => {
        const day = tradeDay(t);
        return Boolean(day && day >= opts.start && day <= opts.end);
      })
      .sort((a, b) => {
        const da = a.trade_date ?? "";
        const db = b.trade_date ?? "";
        return db.localeCompare(da);
      });

    const points = attachCashSleeves(
      tradingPoints,
      windowTrades,
      distributions,
      opts.start,
      opts.end,
    );

    const rowTruncated = raw.length >= 3000;
    return {
      ok: true,
      view: {
        accounts: publicAccounts,
        account: selected.id,
        range: opts.range,
        start: opts.start,
        end: opts.end,
        symbol: ticker,
        points,
        summary: {
          ...summary,
          distributions_total: distributionsTotal,
        },
        fills,
        distributions,
        trades: windowTrades,
        may_be_truncated: rowTruncated || lookbackTruncated,
        lookback_truncated: lookbackTruncated,
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
