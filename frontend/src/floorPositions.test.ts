import assert from 'node:assert/strict';
import test from 'node:test';
import type { SchwabPortfolio, SchwabPortfolioPosition } from './api.ts';
import {
  BOOK_ASK_PROMPT,
  FLOOR_POSITION_LIMIT,
  bookAskPrompt,
  flattenSchwabPositions,
  formatMoney,
  formatQty,
  pnlTone,
  positionDescription,
  rankFloorPositions,
  type FloorPosition,
} from './floorPositions.ts';

function position(overrides: Partial<SchwabPortfolioPosition> = {}): SchwabPortfolioPosition {
  return {
    id: 'pos-1',
    symbol: 'AAPL',
    underlying: null,
    description: 'Apple Inc',
    asset_type: 'EQUITY',
    quantity: 10,
    average_price: 180,
    market_value: 1900,
    day_pnl: 12,
    open_pnl: 100,
    ...overrides,
  };
}

function book(accounts: SchwabPortfolio['accounts']): SchwabPortfolio {
  return {
    ok: true,
    connected: true,
    fetched_at: '2026-09-04T12:00:00.000Z',
    accounts,
    totals: {
      cash: 0,
      equity: 0,
      buying_power: 0,
      day_pnl: 0,
      open_pnl: 0,
      position_count: accounts.reduce((n, account) => n + account.positions.length, 0),
      account_count: accounts.length,
    },
  };
}

function account(
  id: string,
  masked: string,
  positions: SchwabPortfolioPosition[],
): SchwabPortfolio['accounts'][number] {
  return {
    id,
    account_number_masked: masked,
    type: 'BROKERAGE',
    cash: 1000,
    equity: 5000,
    buying_power: 2000,
    day_pnl: 10,
    open_pnl: 50,
    positions,
  };
}

test('formatMoney and formatQty blank missing figures', () => {
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(-80), '-$80.00');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatQty(2.5), '2.5');
  assert.equal(formatQty(null), '—');
});

test('pnlTone maps sign and treats zero as flat', () => {
  assert.equal(pnlTone(1), 'green');
  assert.equal(pnlTone(-0.01), 'red');
  assert.equal(pnlTone(0), 'gray');
  assert.equal(pnlTone(null), 'gray');
});

test('flattenSchwabPositions labels lots only when more than one account', () => {
  const single = flattenSchwabPositions(book([
    account('a', '••••1234', [position({ id: 'p1' })]),
  ]));
  assert.equal(single[0]?.account_label, null);

  const multi = flattenSchwabPositions(book([
    account('a', '••••1234', [position({ id: 'p1', symbol: 'AAPL' })]),
    account('b', '••••5678', [position({ id: 'p2', symbol: 'MSFT' })]),
  ]));
  assert.deepEqual(multi.map((row) => [row.symbol, row.account_label]), [
    ['AAPL', '••••1234'],
    ['MSFT', '••••5678'],
  ]);
});

test('rankFloorPositions prefers larger marks, then day move', () => {
  const rows: FloorPosition[] = [
    { ...position({ id: 'small', symbol: 'AAA', market_value: 100, day_pnl: 50 }), account_label: null },
    { ...position({ id: 'big', symbol: 'BBB', market_value: 5000, day_pnl: 1 }), account_label: null },
    { ...position({ id: 'tie-b', symbol: 'DDD', market_value: 200, day_pnl: 9 }), account_label: null },
    { ...position({ id: 'tie-a', symbol: 'CCC', market_value: 200, day_pnl: 40 }), account_label: null },
  ];
  assert.deepEqual(rankFloorPositions(rows).map((row) => row.id), [
    'big',
    'tie-a',
    'tie-b',
    'small',
  ]);
});

test('rankFloorPositions caps the Floor scan', () => {
  const rows: FloorPosition[] = Array.from({ length: FLOOR_POSITION_LIMIT + 3 }, (_, i) => ({
    ...position({
      id: `p${i}`,
      symbol: `T${i}`,
      market_value: 1000 - i,
    }),
    account_label: null,
  }));
  assert.equal(rankFloorPositions(rows).length, FLOOR_POSITION_LIMIT);
});

test('positionDescription prefers Schwab text and appends the account when shared', () => {
  assert.equal(
    positionDescription({ ...position(), account_label: null }),
    'Apple Inc',
  );
  assert.equal(
    positionDescription({
      ...position({ description: null, quantity: 3, asset_type: 'EQUITY' }),
      account_label: '••••1234',
    }),
    '3 EQUITY · ••••1234',
  );
});

test('bookAskPrompt names the largest day mover when one exists', () => {
  const quiet: FloorPosition[] = [
    { ...position({ day_pnl: 0.2, symbol: 'AAPL' }), account_label: null },
  ];
  assert.equal(bookAskPrompt(quiet), BOOK_ASK_PROMPT);
  assert.equal(bookAskPrompt([]), BOOK_ASK_PROMPT);

  const option: FloorPosition[] = [
    {
      ...position({
        symbol: 'AAPL  260918C00220000',
        underlying: 'AAPL',
        asset_type: 'OPTION',
        day_pnl: 240,
      }),
      account_label: null,
    },
    { ...position({ id: 'eq', symbol: 'MSFT', day_pnl: 12 }), account_label: null },
  ];
  assert.match(bookAskPrompt(option), /AAPL/);
  assert.doesNotMatch(bookAskPrompt(option), /260918C/);
});
