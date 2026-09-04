/**
 * Floor Schwab-book overview — rank, format, and prompt helpers.
 * The card stays a 5-second scan; Portfolio owns the full book.
 */
import type { SchwabPortfolio, SchwabPortfolioPosition } from './api';
import { positionTicker } from './schwabPnlView.ts';

export const FLOOR_POSITION_LIMIT = 6;

export const BOOK_ASK_PROMPT =
  "What's moving in my Schwab book today? Lead with the day P&L drivers and whether any names need an adjustment.";

export type FloorPosition = SchwabPortfolioPosition & {
  /** Masked account label when more than one linked account is in the book. */
  account_label: string | null;
};

export function flattenSchwabPositions(book: SchwabPortfolio): FloorPosition[] {
  const multi = book.accounts.length > 1;
  const rows: FloorPosition[] = [];
  for (const account of book.accounts) {
    const label = multi ? account.account_number_masked : null;
    for (const position of account.positions) {
      rows.push({ ...position, account_label: label });
    }
  }
  return rows;
}

/** Largest marks first so the Floor scan shows what actually moves the book. */
export function rankFloorPositions(
  positions: readonly FloorPosition[],
  limit = FLOOR_POSITION_LIMIT,
): FloorPosition[] {
  return [...positions]
    .sort((a, b) => {
      const mark = Math.abs(b.market_value ?? 0) - Math.abs(a.market_value ?? 0);
      if (mark !== 0) return mark;
      const day = Math.abs(b.day_pnl ?? 0) - Math.abs(a.day_pnl ?? 0);
      if (day !== 0) return day;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, Math.max(0, limit));
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function pnlTone(n: number | null | undefined): 'green' | 'red' | 'gray' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gray';
  return n > 0 ? 'green' : 'red';
}

export function positionDescription(row: FloorPosition): string {
  const qty = formatQty(row.quantity);
  const kind = row.asset_type?.trim() || 'shares';
  const base = row.description?.trim() || `${qty} ${kind}`;
  return row.account_label ? `${base} · ${row.account_label}` : base;
}

export function bookAskPrompt(positions: readonly FloorPosition[]): string {
  const movers = [...positions]
    .filter((row) => row.day_pnl != null && Number.isFinite(row.day_pnl) && Math.abs(row.day_pnl) >= 1)
    .sort((a, b) => Math.abs(b.day_pnl ?? 0) - Math.abs(a.day_pnl ?? 0));
  const lead = movers[0];
  if (!lead) return BOOK_ASK_PROMPT;
  const ticker = positionTicker(lead);
  return `What's driving ${ticker} in my Schwab book today? Tie it to the rest of the open book and whether the position needs an adjustment.`;
}
