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
