import type {
  SchwabDistribution,
  SchwabPnlFill,
  SchwabPnlPoint,
  SchwabPortfolioPosition,
  SchwabTrade,
} from './api';

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
): Array<SchwabPnlPoint & { daily: number; cumulative: number }> {
  let cumulative = 0;
  return points.map((point) => {
    const daily = composeDaily(point, include);
    cumulative += daily;
    return { ...point, daily, cumulative };
  });
}

export function composeTotals(
  points: SchwabPnlPoint[],
  include: PnlInclude,
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
  return {
    period: composeSeries(points, include).at(-1)?.cumulative ?? 0,
    stocks,
    options,
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
    const day = (fill?.date
      ?? (trade.trade_date && /^\d{4}-\d{2}-\d{2}/.test(trade.trade_date)
        ? trade.trade_date.slice(0, 10)
        : null))
      ?? '';
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
