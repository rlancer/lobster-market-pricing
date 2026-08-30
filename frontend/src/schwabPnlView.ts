import type {
  SchwabDistribution,
  SchwabPnlFill,
  SchwabPnlPoint,
  SchwabPortfolioPosition,
  SchwabTrade,
} from './api';
import { etTradeDay } from './tickerChartRange.ts';

export type PnlInclude = {
  stocks: boolean;
  options: boolean;
  dividends: boolean;
  fees: boolean;
};

export const DEFAULT_PNL_INCLUDE: PnlInclude = {
  stocks: true,
  options: true,
  dividends: true,
  fees: true,
};

export type ActivityKind = 'stock' | 'option' | 'dividend';

export type ActivityRow = {
  id: string;
  date: string;
  kind: ActivityKind;
  side: SchwabTrade['side'] | null;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  net_amount: number | null;
  fees: number | null;
  realized_pnl: number | null;
  prior_open: boolean;
  description: string | null;
};

export function isOptionLike(row: {
  asset_type?: string | null;
  symbol?: string | null;
}): boolean {
  if ((row.asset_type ?? '').toUpperCase() === 'OPTION') return true;
  const compact = (row.symbol ?? '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9.-]{1,6}\d{6}[CP]\d{8}$/.test(compact);
}

function n(v: number | null | undefined): number {
  return v != null && Number.isFinite(v) ? v : 0;
}

/** Commission drag. Live Schwab fee amounts are often the charged (positive) figure. */
function feeDrag(v: number | null | undefined): number {
  const x = n(v);
  return x > 0 ? -x : x;
}

/** Live open-mark sleeves that the include chips currently allow. */
export function includedOpenMark(
  mark: { equity_pnl: number; option_pnl: number } | null | undefined,
  include: PnlInclude,
): number {
  if (!mark) return 0;
  return (include.stocks ? n(mark.equity_pnl) : 0) + (include.options ? n(mark.option_pnl) : 0);
}

/** Daily composed P&L for the selected sleeves. */
export function composeDaily(point: SchwabPnlPoint, include: PnlInclude): number {
  const stocks = include.stocks ? n(point.daily_equity_pnl) : 0;
  const options = include.options ? n(point.daily_option_pnl) : 0;
  const dividends = include.dividends ? n(point.daily_dividends) : 0;
  const trading = stocks + options;
  const sleeveFees =
    (include.stocks ? feeDrag(point.daily_equity_fees) : 0) +
    (include.options ? feeDrag(point.daily_option_fees) : 0);
  const allFees = feeDrag(point.daily_fees);

  const tradingOn = include.stocks || include.options;
  if (!tradingOn && !include.dividends && include.fees) return allFees;
  if (!tradingOn) return dividends;

  const traded = include.fees ? trading : trading - sleeveFees;
  return traded + dividends;
}

export function composeSeries(
  points: SchwabPnlPoint[],
  include: PnlInclude,
  openMarkPnl = 0,
  startCumulative = 0,
): Array<SchwabPnlPoint & { daily: number; cumulative: number }> {
  let cumulative = startCumulative;
  const rows = points.map((point) => {
    const daily = composeDaily(point, include);
    cumulative += daily;
    return { ...point, daily, cumulative };
  });
  if (openMarkPnl === 0 || rows.length === 0) return rows;
  const last = rows[rows.length - 1]!;
  last.daily += openMarkPnl;
  last.cumulative += openMarkPnl;
  return rows;
}

export function composeTotals(
  points: SchwabPnlPoint[],
  include: PnlInclude,
  mark: { equity_pnl: number; option_pnl: number } | null = null,
  opts?: { startCumulative?: number; lastPointPnl?: number },
): { period: number; stocks: number; options: number; dividends: number; fees: number } {
  let stocks = 0;
  let options = 0;
  let dividends = 0;
  let fees = 0;
  for (const p of points) {
    stocks += n(p.daily_equity_pnl);
    options += n(p.daily_option_pnl);
    dividends += n(p.daily_dividends);
    fees += feeDrag(p.daily_fees);
  }
  const startCumulative = opts?.startCumulative ?? 0;
  const lastPointPnl = opts?.lastPointPnl ?? includedOpenMark(mark, include);
  return {
    period: composeSeries(points, include, lastPointPnl, startCumulative).at(-1)?.cumulative
      ?? startCumulative + lastPointPnl,
    stocks: stocks + n(mark?.equity_pnl),
    options: options + n(mark?.option_pnl),
    dividends,
    fees,
  };
}

export function buildActivityRows(opts: {
  trades: SchwabTrade[];
  fills: SchwabPnlFill[];
  distributions: SchwabDistribution[];
}): ActivityRow[] {
  const realized = new Map<string, SchwabPnlFill>();
  for (const fill of opts.fills) realized.set(fill.id, fill);

  const rows: ActivityRow[] = [];
  for (const trade of opts.trades) {
    const fill = realized.get(trade.id);
    const day = fill?.date ?? etTradeDay(trade.trade_date) ?? '';
    if (!day) continue;
    rows.push({
      id: `trade-${trade.id}`,
      date: day,
      kind: isOptionLike(trade) ? 'option' : 'stock',
      side: trade.side,
      symbol: trade.symbol,
      quantity: trade.quantity != null ? Math.abs(trade.quantity) : null,
      price: trade.price,
      net_amount: trade.net_amount,
      fees: trade.fees,
      realized_pnl: fill?.realized_pnl ?? null,
      prior_open: Boolean(fill?.prior_open),
      description: trade.description,
    });
  }

  const tradeIds = new Set(opts.trades.map((t) => t.id));
  for (const fill of opts.fills) {
    if (tradeIds.has(fill.id)) continue;
    rows.push({
      id: `fill-${fill.id}`,
      date: fill.date,
      kind: isOptionLike(fill) ? 'option' : 'stock',
      side: fill.side,
      symbol: fill.symbol,
      quantity: fill.quantity != null ? Math.abs(fill.quantity) : null,
      price: fill.price,
      net_amount: fill.net_amount,
      fees: fill.fees,
      realized_pnl: fill.realized_pnl,
      prior_open: Boolean(fill.prior_open),
      description: fill.description,
    });
  }

  for (const dist of opts.distributions) {
    rows.push({
      id: dist.id,
      date: dist.date,
      kind: 'dividend',
      side: null,
      symbol: dist.symbol,
      quantity: null,
      price: null,
      net_amount: dist.amount,
      fees: null,
      realized_pnl: dist.amount,
      prior_open: false,
      description: dist.description,
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.id.localeCompare(b.id);
  });
  return rows;
}

export function filterActivity(rows: ActivityRow[], include: PnlInclude): ActivityRow[] {
  const tradingOn = include.stocks || include.options;
  const feesOnly = include.fees && !tradingOn && !include.dividends;
  if (feesOnly) {
    return rows.filter((row) => row.fees != null && row.fees !== 0);
  }
  return rows.filter((row) => {
    if (row.kind === 'stock') return include.stocks;
    if (row.kind === 'option') return include.options;
    return include.dividends;
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

function tradeDay(trade: Pick<SchwabTrade, 'trade_date'>): string | null {
  return etTradeDay(trade.trade_date);
}

export type EquityOpenLot = {
  /** ET session date of the open; null when the opening fill is not in this window. */
  opened: string | null;
  quantity: number;
  average_price: number;
  live_pnl: number;
};

/** Still-open equity/ETF lot for a scoped ticker (options excluded). */
export function equityOpenLot(
  positions: SchwabPortfolioPosition[],
  trades: SchwabTrade[],
  ticker: string | null | undefined,
): EquityOpenLot | null {
  const want = ticker?.trim().toUpperCase();
  if (!want) return null;
  const matched = positions.filter((p) => positionTicker(p) === want && !isOptionLike(p));
  if (matched.length === 0) return null;
  let quantity = 0;
  let live = 0;
  let cost = 0;
  let costQty = 0;
  for (const p of matched) {
    quantity += p.quantity;
    live += positionMarkPnl(p);
    if (p.average_price != null && Number.isFinite(p.average_price)) {
      cost += p.average_price * p.quantity;
      costQty += p.quantity;
    }
  }
  if (quantity === 0) return null;
  let average_price = costQty !== 0 ? cost / costQty : null;
  let opened: string | null = null;
  for (const trade of trades) {
    if (isOptionLike(trade)) continue;
    const day = tradeDay(trade);
    if (!day) continue;
    const sym = (trade.symbol ?? '').trim().toUpperCase();
    const und = (trade.underlying ?? '').trim().toUpperCase();
    if (sym !== want && und !== want) continue;
    if (!opened || day < opened) opened = day;
    if (average_price == null && trade.price != null && Number.isFinite(trade.price)) {
      average_price = trade.price;
    }
  }
  if (average_price == null || !Number.isFinite(average_price)) return null;
  return {
    opened,
    quantity,
    average_price,
    live_pnl: live,
  };
}

/**
 * Paint daily equity mark-to-market from Schwab (or lake-fallback) OHLC so
 * the chart follows the holding. In-window days are incremental (prior
 * close → close). Lots opened inside the window use fill price on the first
 * session. Last-session drift to Schwab's full open_pnl is applied via
 * series carry-in, not a one-day dump on the first or last bar.
 */
export function applyEquityMarkPath(
  points: SchwabPnlPoint[],
  ohlc: Array<{ date: string; close: number | null | undefined }>,
  lot: EquityOpenLot | null,
  rangeStart: string,
  rangeEnd: string,
): { points: SchwabPnlPoint[]; painted: boolean; inWindowMtm: number } {
  const none = { points, painted: false, inWindowMtm: 0 };
  if (!lot || lot.quantity === 0 || !rangeStart || !rangeEnd) return none;

  const allBars = ohlc
    .filter((b) => b.close != null && Number.isFinite(b.close))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const inBars = allBars.filter((b) => b.date >= rangeStart && b.date <= rangeEnd);
  if (inBars.length === 0) return none;

  const opened = lot.opened;
  const openedInRange = Boolean(opened && opened >= rangeStart && opened <= rangeEnd);
  const pathStart = opened && opened > rangeStart ? opened : rangeStart;
  const prior = [...allBars].reverse().find((b) => b.date < pathStart);
  let prev: number | null = openedInRange ? lot.average_price : (prior?.close ?? null);
  if (prev == null) return none;

  const byDate = new Map<string, SchwabPnlPoint>();
  for (const p of points) byDate.set(p.date, { ...p });
  const touch = (date: string): SchwabPnlPoint => {
    let row = byDate.get(date);
    if (!row) {
      row = emptyPoint(date);
      byDate.set(date, row);
    }
    return row;
  };
  for (const bar of inBars) touch(bar.date);

  let mtmSum = 0;
  let lastMtmDate: string | null = null;
  for (const bar of inBars) {
    if (opened && bar.date < opened) continue;
    const close = bar.close as number;
    const change = round2(lot.quantity * (close - prev));
    const row = touch(bar.date);
    row.daily_equity_pnl = round2(n(row.daily_equity_pnl) + change);
    row.daily_pnl = round2(n(row.daily_pnl) + change);
    mtmSum = round2(mtmSum + change);
    prev = close;
    lastMtmDate = bar.date;
  }
  if (lastMtmDate == null) return none;
  return {
    points: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    painted: true,
    inWindowMtm: mtmSum,
  };
}

const OPTION_MULTIPLIER = 100;

export function compactOccSymbol(symbol: string | null | undefined): string | null {
  const compact = (symbol ?? '').toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9.-]{1,6}\d{6}[CP]\d{8}$/.test(compact) ? compact : null;
}

export type OptionLot = {
  id: string;
  symbol: string;
  opened: string | null;
  closed: string | null;
  /** Signed contracts: long +, short −. */
  quantity: number;
  average_price: number;
  exit_price: number | null;
  /** FIFO amount currently stamped onto the close day. */
  realized_pnl: number;
  /** Assigned-stock realization reclassified onto the short option. */
  assignment_equity_pnl: number;
  target_pnl: number;
  prior_open: boolean;
};

function optionRoot(symbol: string | null | undefined): string | null {
  const compact = compactOccSymbol(symbol);
  return compact
    ? /^([A-Z0-9.-]{1,6})\d{6}[CP]\d{8}$/.exec(compact)?.[1] ?? null
    : null;
}

function isAssignmentFill(fill: SchwabPnlFill): boolean {
  return fill.id.startsWith('synth-assign-')
    || /^Option assignment close\b/i.test(fill.description ?? '');
}

/** Closed period option lots (and still-open option positions) for the mark path. */
export function optionLotsFromFills(
  fills: SchwabPnlFill[],
  positions: SchwabPortfolioPosition[] = [],
): OptionLot[] {
  const lots: OptionLot[] = [];
  const closed = new Set<string>();
  const usedEquityFills = new Set<string>();
  for (const fill of fills) {
    if (!isOptionLike(fill) || fill.prior_open) continue;
    const symbol = compactOccSymbol(fill.symbol);
    if (!symbol) continue;
    const absQty = Math.abs(fill.quantity ?? 0);
    if (absQty === 0) continue;
    const signed = fill.side === 'buy' ? -absQty : fill.side === 'sell' ? absQty : 0;
    if (signed === 0) continue;
    const reportedExit = fill.price != null && Number.isFinite(fill.price) ? fill.price : 0;
    const realized = n(fill.realized_pnl);
    const denom = signed * OPTION_MULTIPLIER;
    const average_price = denom !== 0 ? reportedExit - realized / denom : reportedExit;

    // Schwab omits the short-option close on assignment. FIFO therefore books
    // the premium as a zero-price option win and the intrinsic loss on the
    // delivered stock. That is cash-correct but mark-path-wrong. Pair the
    // synthetic cover with the same-day, same-size stock realization and move
    // that amount onto the option, yielding an intrinsic assignment close.
    let assignmentEquityPnl = 0;
    if (isAssignmentFill(fill)) {
      const root = optionRoot(fill.symbol);
      const assignedShares = absQty * OPTION_MULTIPLIER;
      const equity = fills.find((candidate) => {
        if (usedEquityFills.has(candidate.id) || isOptionLike(candidate)) return false;
        if (candidate.date !== fill.date || candidate.prior_open) return false;
        const candidateRoot = (candidate.underlying ?? candidate.symbol ?? '').trim().toUpperCase();
        if (!root || candidateRoot !== root) return false;
        return Math.abs(Math.abs(candidate.quantity ?? 0) - assignedShares) < 1e-8;
      });
      if (equity) {
        assignmentEquityPnl = n(equity.realized_pnl);
        usedEquityFills.add(equity.id);
      }
    }
    const target = round2(realized + assignmentEquityPnl);
    const exit = denom !== 0 ? average_price + target / denom : reportedExit;
    lots.push({
      id: fill.id,
      symbol,
      opened: fill.opened || null,
      closed: fill.date,
      quantity: signed,
      average_price,
      exit_price: exit,
      realized_pnl: realized,
      assignment_equity_pnl: assignmentEquityPnl,
      target_pnl: target,
      prior_open: false,
    });
    closed.add(symbol);
  }
  for (const position of positions) {
    if (!isOptionLike(position) || position.quantity === 0) continue;
    const symbol = compactOccSymbol(position.symbol);
    if (!symbol || closed.has(symbol)) continue;
    if (position.average_price == null || !Number.isFinite(position.average_price)) continue;
    lots.push({
      id: position.id,
      symbol,
      opened: null,
      closed: null,
      quantity: position.quantity,
      average_price: position.average_price,
      exit_price: null,
      realized_pnl: 0,
      assignment_equity_pnl: 0,
      target_pnl: n(position.open_pnl),
      prior_open: false,
    });
  }
  return lots;
}

export function densifyWithOhlc(
  points: SchwabPnlPoint[],
  ohlc: Array<{ date: string; close?: number | null }>,
  rangeStart: string,
  rangeEnd: string,
): SchwabPnlPoint[] {
  if (!rangeStart || !rangeEnd || ohlc.length === 0) return points;
  const byDate = new Map<string, SchwabPnlPoint>();
  for (const p of points) byDate.set(p.date, { ...p });
  for (const bar of ohlc) {
    if (!bar.date || bar.date < rangeStart || bar.date > rangeEnd) continue;
    if (!byDate.has(bar.date)) byDate.set(bar.date, emptyPoint(bar.date));
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Replace the one-day FIFO option lump with daily mark-to-market. Schwab
 * option closes are preferred. If Schwab has no option history, deep-ITM
 * contracts use intrinsic value from Schwab underlying closes. Assignment
 * moves the delivered-stock intrinsic loss onto the short option.
 */
export function applyOptionMarkPath(
  points: SchwabPnlPoint[],
  ohlcBySymbol: Record<string, Array<{ date: string; close: number | null | undefined }>>,
  lots: OptionLot[],
  rangeStart: string,
  rangeEnd: string,
  underlyingOhlc: Array<{ date: string; close: number | null | undefined }> = [],
): { points: SchwabPnlPoint[]; painted: boolean; inWindowMtm: number; closedPnl: number } {
  const none = { points, painted: false, inWindowMtm: 0, closedPnl: 0 };
  if (!rangeStart || !rangeEnd || lots.length === 0) return none;

  const byDate = new Map<string, SchwabPnlPoint>();
  for (const p of points) byDate.set(p.date, { ...p });
  const touch = (date: string): SchwabPnlPoint => {
    let row = byDate.get(date);
    if (!row) {
      row = emptyPoint(date);
      byDate.set(date, row);
    }
    return row;
  };

  let painted = false;
  let inWindowMtm = 0;
  let closedPnl = 0;

  for (const lot of lots) {
    if (lot.prior_open || lot.quantity === 0) continue;
    if (lot.closed && lot.closed < rangeStart) continue;
    if (lot.opened && lot.opened > rangeEnd) continue;

    const pathStart = lot.opened && lot.opened > rangeStart ? lot.opened : rangeStart;
    const pathEnd = lot.closed && lot.closed < rangeEnd ? lot.closed : rangeEnd;
    let raw = ohlcBySymbol[lot.symbol] ?? [];
    if (raw.length < 2) {
      const occ = /^([A-Z0-9.-]{1,6})(\d{6})([CP])(\d{8})$/.exec(lot.symbol);
      const strike = occ ? Number(occ[4]) / 1000 : Number.NaN;
      let intrinsic = occ && Number.isFinite(strike)
        ? underlyingOhlc
            .filter((b) => (
              b.date <= pathEnd
              && b.close != null
              && Number.isFinite(b.close)
            ))
            .map((b) => ({
              date: b.date,
              close: occ[3] === 'P'
                ? Math.max(strike - (b.close as number), 0)
                : Math.max((b.close as number) - strike, 0),
            }))
        : [];
      // Intrinsic is a defensible proxy only while the contract stays ITM.
      // This covers CAR's deep-ITM 390/500 put spread without pretending that
      // a zero intrinsic value captures time value for an OTM option.
      if (intrinsic.length >= 2 && intrinsic.every((b) => b.close > 0)) {
        const opened = lot.opened;
        if (opened && opened >= rangeStart) {
          const active = intrinsic.filter((b) => b.date >= opened);
          if (active.length >= 2) {
            // Anchor the proxy at the actual fill, then let entry time value
            // decay smoothly into intrinsic by the close. This avoids merely
            // moving the vertical jump from assignment day to opening day.
            const entryOffset = lot.average_price - active[0]!.close;
            const last = active.length - 1;
            const modeled = new Map(
              active.map((bar, index) => [
                bar.date,
                {
                  ...bar,
                  close: bar.close + entryOffset * (1 - index / last),
                },
              ]),
            );
            intrinsic = intrinsic.map((bar) => modeled.get(bar.date) ?? bar);
          }
        }
        raw = intrinsic;
      }
    }
    const bars = raw
      .filter((b) => (
        b.date >= pathStart
        && b.date <= pathEnd
        && b.close != null
        && Number.isFinite(b.close)
      ))
      .map((b) => ({ date: b.date, close: b.close as number }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (lot.closed && lot.closed >= rangeStart && lot.closed <= rangeEnd && lot.exit_price != null) {
      const i = bars.findIndex((b) => b.date === lot.closed);
      if (i >= 0) bars[i] = { date: lot.closed, close: lot.exit_price };
      else bars.push({ date: lot.closed, close: lot.exit_price });
      bars.sort((a, b) => a.date.localeCompare(b.date));
    }
    if (bars.length === 0) continue;

    const openedInRange = !lot.opened || lot.opened >= rangeStart;
    const prior = [...raw]
      .filter((b) => b.date < pathStart && b.close != null && Number.isFinite(b.close))
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    let prev: number | null = openedInRange ? lot.average_price : (prior?.close ?? null);
    if (prev == null) prev = bars[0]!.close;

    if (lot.closed && lot.realized_pnl !== 0) {
      const row = touch(lot.closed);
      row.daily_option_pnl = round2(n(row.daily_option_pnl) - lot.realized_pnl);
      row.daily_pnl = round2(n(row.daily_pnl) - lot.realized_pnl);
    }
    if (lot.closed && lot.assignment_equity_pnl !== 0) {
      const row = touch(lot.closed);
      row.daily_equity_pnl = round2(
        n(row.daily_equity_pnl) - lot.assignment_equity_pnl,
      );
      row.daily_pnl = round2(n(row.daily_pnl) - lot.assignment_equity_pnl);
    }

    let lotSum = 0;
    let lastDate: string | null = null;
    for (const bar of bars) {
      const change = round2(lot.quantity * OPTION_MULTIPLIER * (bar.close - prev));
      const row = touch(bar.date);
      row.daily_option_pnl = round2(n(row.daily_option_pnl) + change);
      row.daily_pnl = round2(n(row.daily_pnl) + change);
      lotSum = round2(lotSum + change);
      prev = bar.close;
      lastDate = bar.date;
    }
    if (lastDate && lot.closed) {
      const drift = round2(lot.target_pnl - lotSum);
      if (drift !== 0) {
        const row = touch(lastDate);
        row.daily_option_pnl = round2(n(row.daily_option_pnl) + drift);
        row.daily_pnl = round2(n(row.daily_pnl) + drift);
        lotSum = round2(lotSum + drift);
      }
      closedPnl = round2(closedPnl + lot.target_pnl);
    }
    inWindowMtm = round2(inWindowMtm + lotSum);
    painted = true;
  }

  if (!painted) return none;
  return {
    points: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    painted: true,
    inWindowMtm,
    closedPnl,
  };
}

/** Root ticker for a Schwab position (option → underlying / OCC root). */
export function positionTicker(row: Pick<SchwabPortfolioPosition, 'symbol' | 'underlying' | 'asset_type'>): string {
  const und = row.underlying?.trim().toUpperCase();
  if (und) return und;
  const symbol = row.symbol.trim().toUpperCase();
  const compact = symbol.replace(/\s+/g, '');
  const occ = /^([A-Z0-9.-]{1,6})\d{6}[CP]\d{8}$/.exec(compact);
  if (occ) return occ[1]!;
  return symbol;
}

function positionMarkPnl(row: Pick<SchwabPortfolioPosition, 'open_pnl' | 'market_value' | 'average_price' | 'quantity'>): number {
  if (row.open_pnl != null && Number.isFinite(row.open_pnl)) return row.open_pnl;
  if (
    row.average_price != null &&
    row.market_value != null &&
    Number.isFinite(row.average_price) &&
    Number.isFinite(row.market_value)
  ) {
    return row.market_value - row.average_price * row.quantity;
  }
  return 0;
}

/**
 * Live open mark for a scoped ticker. Whole-account (no ticker) returns null
 * so the curve stays realized-only.
 */
export function tickerOpenMark(
  positions: SchwabPortfolioPosition[],
  ticker: string | null | undefined,
): { count: number; equity_pnl: number; option_pnl: number } | null {
  const want = ticker?.trim().toUpperCase();
  if (!want) return null;
  let count = 0;
  let equity_pnl = 0;
  let option_pnl = 0;
  for (const row of positions) {
    if (positionTicker(row) !== want) continue;
    count += 1;
    const pnl = positionMarkPnl(row);
    if (isOptionLike(row)) option_pnl += pnl;
    else equity_pnl += pnl;
  }
  if (count === 0) return null;
  return { count, equity_pnl, option_pnl };
}
