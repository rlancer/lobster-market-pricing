/**
 * Realized trading PnL time series from Schwab TRADE history.
 *
 * Builds a FIFO lot ledger from normalized trades, then daily + cumulative
 * realized PnL for chart presets (MTD / YTD / 1M / … / 1Y). Not an account
 * equity curve — deposits, withdrawals, and open mark-to-market are excluded.
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";
import {
  listSchwabAccountNumbers,
  listSchwabTransactions,
  normalizeTrade,
  toTradeAccounts,
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

export interface SchwabPnlSummary {
  period_pnl: number;
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

function lotKey(trade: SchwabTrade): string {
  if (trade.position_id != null) return `pos:${trade.position_id}`;
  if (trade.symbol) return `sym:${trade.symbol}`;
  if (trade.underlying) return `und:${trade.underlying}`;
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
}

export interface RealizedPnlLedger {
  /** YYYY-MM-DD → realized dollars that day. */
  daily: Map<string, number>;
  tradeCount: number;
  closingTradeCount: number;
  unmatchedCloseCount: number;
  skippedTradeCount: number;
}

/**
 * FIFO realized PnL from chronological trades.
 * Opens add lots; opposite-side fills close lots and realize proceeds − basis.
 * CLOSING fills with no in-window basis are skipped (counted unmatched).
 */
export function buildRealizedPnlLedger(trades: SchwabTrade[]): RealizedPnlLedger {
  const chron = [...trades].sort((a, b) => {
    const da = a.trade_date ?? "";
    const db = b.trade_date ?? "";
    if (da !== db) return da.localeCompare(db);
    const ia = a.activity_id ?? 0;
    const ib = b.activity_id ?? 0;
    return ia - ib;
  });

  const books = new Map<string, Lot[]>();
  const daily = new Map<string, number>();
  let tradeCount = 0;
  let closingTradeCount = 0;
  let unmatchedCloseCount = 0;
  let skippedTradeCount = 0;

  const bump = (day: string, amount: number) => {
    daily.set(day, (daily.get(day) ?? 0) + amount);
  };

  for (const trade of chron) {
    const day = tradeDay(trade);
    const qty = absQty(trade);
    const cash = tradeCash(trade);
    if (!day || qty == null || cash == null || trade.side === "unknown") {
      skippedTradeCount += 1;
      continue;
    }
    tradeCount += 1;

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
      bump(day, realized);
      closedQtyTotal += closeQty;

      head.qty -= closeQty;
      head.costTotal -= closeBasis;
      cashLeft -= closeCash;
      remaining += head.direction === "long" ? closeQty : -closeQty;

      if (head.qty <= 1e-12) lots.shift();
    }

    if (closedQtyTotal > 0) closingTradeCount += 1;

    const rem = Math.abs(remaining);
    if (rem <= 1e-12) {
      if (Math.abs(cashLeft) > 1e-6) bump(day, cashLeft);
      continue;
    }

    // Explicit CLOSING with no (or insufficient) basis in the fetch window.
    if (effect === "CLOSING") {
      unmatchedCloseCount += 1;
      continue;
    }

    const direction: "long" | "short" = remaining > 0 ? "long" : "short";
    const costTotal = Math.abs(direction === "long" ? -cashLeft : cashLeft);
    const last = lots[lots.length - 1];
    if (last && last.direction === direction) {
      last.qty += rem;
      last.costTotal += costTotal;
    } else {
      lots.push({ qty: rem, costTotal, direction });
    }
  }

  return {
    daily,
    tradeCount,
    closingTradeCount,
    unmatchedCloseCount,
    skippedTradeCount,
  };
}

/** Sparse daily points + cumulative series between start/end (inclusive). */
export function seriesFromLedger(
  ledger: RealizedPnlLedger,
  start: string,
  end: string,
): { points: SchwabPnlPoint[]; summary: SchwabPnlSummary } {
  const activeDays = [...ledger.daily.keys()].filter((d) => d >= start && d <= end).sort();
  const pointDays = new Set<string>([start, end, ...activeDays]);
  const ordered = [...pointDays].sort();

  let cumulative = 0;
  const points: SchwabPnlPoint[] = [];
  for (const date of ordered) {
    const dayPnl = date >= start && date <= end ? (ledger.daily.get(date) ?? 0) : 0;
    if (date >= start && date <= end) cumulative += dayPnl;
    points.push({
      date,
      daily_pnl: round2(dayPnl),
      cumulative_pnl: round2(cumulative),
    });
  }

  let period = 0;
  for (const [d, v] of ledger.daily) {
    if (d >= start && d <= end) period += v;
  }

  return {
    points,
    summary: {
      period_pnl: round2(period),
      trade_count: ledger.tradeCount,
      closing_trade_count: ledger.closingTradeCount,
      unmatched_close_count: ledger.unmatchedCloseCount,
      skipped_trade_count: ledger.skippedTradeCount,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
          summary: {
            period_pnl: 0,
            trade_count: 0,
            closing_trade_count: 0,
            unmatched_close_count: 0,
            skipped_trade_count: 0,
          },
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
      // Schwab is strict about the 1y window on some accounts — fall back to the
      // chart window alone (still enough for MTD/YTD early in the year).
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

    return {
      ok: true,
      view: {
        accounts: publicAccounts,
        account: selected.id,
        range: opts.range,
        start: opts.start,
        end: opts.end,
        points,
        summary,
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
