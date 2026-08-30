import assert from 'node:assert/strict';
import test from 'node:test';
import type { SchwabPnlPoint, SchwabTrade } from './api.ts';
import {
  buildActivityRows,
  composeDaily,
  composeSeries,
  composeTotals,
  filterActivity,
  positionTicker,
  type PnlInclude,
} from './schwabPnlView.ts';

const ALL: PnlInclude = { stocks: true, options: true, dividends: true, fees: true };

function point(partial: Partial<SchwabPnlPoint> & Pick<SchwabPnlPoint, 'date'>): SchwabPnlPoint {
  return {
    daily_pnl: 0,
    cumulative_pnl: 0,
    daily_equity_pnl: 0,
    daily_option_pnl: 0,
    daily_fees: 0,
    daily_equity_fees: 0,
    daily_option_fees: 0,
    daily_dividends: 0,
    ...partial,
  };
}

test('composeDaily adds selected sleeves and can isolate fees or dividends', () => {
  const p = point({
    date: '2026-02-10',
    daily_equity_pnl: 150,
    daily_option_pnl: 80,
    daily_dividends: 12,
    daily_fees: -3,
    daily_equity_fees: -2,
    daily_option_fees: -1,
  });
  assert.equal(composeDaily(p, ALL), 242);
  assert.equal(composeDaily(p, { ...ALL, options: false }), 162);
  assert.equal(composeDaily(p, { ...ALL, stocks: false, options: false, fees: false }), 12);
  assert.equal(composeDaily(p, { stocks: false, options: false, dividends: false, fees: true }), -3);
  assert.equal(composeDaily(p, { ...ALL, fees: false }), 245);

  const live = point({
    date: '2026-05-08',
    daily_equity_pnl: -24486.32,
    daily_option_pnl: 29507.12,
    daily_fees: 3.2,
    daily_equity_fees: 0.32,
    daily_option_fees: 2.88,
  });
  assert.equal(composeDaily(live, { stocks: false, options: false, dividends: false, fees: true }), -3.2);
  assert.equal(
    composeDaily(live, { stocks: true, options: true, dividends: false, fees: false }),
    -24486.32 + 29507.12 + 3.2,
  );
});

test('composeSeries accumulates the composed daily', () => {
  const series = composeSeries([
    point({ date: '2026-01-01', daily_equity_pnl: 10 }),
    point({ date: '2026-01-02', daily_option_pnl: -4, daily_dividends: 2 }),
  ], ALL);
  assert.equal(series[0]?.cumulative, 10);
  assert.equal(series[1]?.cumulative, 8);
  assert.equal(composeTotals(series, ALL).period, 8);
});

test('buildActivityRows unifies trades, realized fills, and dividends', () => {
  const trades: SchwabTrade[] = [
    {
      id: '1',
      activity_id: 1,
      trade_date: '2026-02-10T15:00:00.000Z',
      settlement_date: null,
      description: 'BOUGHT CAR',
      status: 'VALID',
      activity_type: 'EXECUTION',
      net_amount: -100,
      symbol: 'CAR',
      underlying: null,
      asset_type: 'EQUITY',
      quantity: 10,
      price: 10,
      cost: -100,
      fees: -1,
      side: 'buy',
      position_effect: 'OPENING',
      order_id: null,
      position_id: null,
    },
    {
      id: '2',
      activity_id: 2,
      trade_date: '2026-02-12T15:00:00.000Z',
      settlement_date: null,
      description: 'SOLD CAR PUT',
      status: 'VALID',
      activity_type: 'EXECUTION',
      net_amount: 250,
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      asset_type: 'OPTION',
      quantity: 1,
      price: 2.5,
      cost: 250,
      fees: 0,
      side: 'sell',
      position_effect: 'OPENING',
      order_id: null,
      position_id: null,
    },
  ];
  const rows = buildActivityRows({
    trades,
    fills: [{
      id: '1',
      date: '2026-02-10',
      symbol: 'CAR',
      description: 'BOUGHT CAR',
      side: 'buy',
      quantity: 10,
      price: 10,
      net_amount: -100,
      fees: -1,
      realized_pnl: 40,
      opened: '2026-01-02',
      prior_open: true,
      asset_type: 'EQUITY',
    }],
    distributions: [{
      id: 'd1',
      date: '2026-02-11',
      symbol: 'CAR',
      description: 'Qualified dividend',
      amount: 5,
      type: 'DIVIDEND_OR_INTEREST',
      status: 'VALID',
    }],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.kind, 'option');
  assert.equal(rows[1]?.kind, 'dividend');
  assert.equal(rows[2]?.realized_pnl, 40);
  assert.equal(rows[2]?.prior_open, true);

  const optionsOnly = filterActivity(rows, { stocks: false, options: true, dividends: false, fees: false });
  assert.equal(optionsOnly.length, 1);
  assert.equal(optionsOnly[0]?.kind, 'option');

  const feesOnly = filterActivity(rows, { stocks: false, options: false, dividends: false, fees: true });
  assert.equal(feesOnly.length, 1);
  assert.equal(feesOnly[0]?.fees, -1);
});

test('positionTicker prefers underlying then OCC root', () => {
  assert.equal(positionTicker({ symbol: 'AAPL', underlying: null, asset_type: 'EQUITY' }), 'AAPL');
  assert.equal(positionTicker({
    symbol: 'CAR   260618P00390000',
    underlying: 'CAR',
    asset_type: 'OPTION',
  }), 'CAR');
  assert.equal(positionTicker({
    symbol: 'CAR   260618P00390000',
    underlying: null,
    asset_type: 'OPTION',
  }), 'CAR');
});
