import assert from 'node:assert/strict';
import test from 'node:test';
import type { SchwabPnlPoint, SchwabTrade } from './api.ts';
import {
  applyEquityMarkPath,
  applyOptionMarkPath,
  buildActivityRows,
  parseOccContract,
  composeDaily,
  composeSeries,
  composeTotals,
  densifyWithOhlc,
  equityOpenLot,
  filterActivity,
  includedOpenMark,
  optionLotsFromFills,
  optionLegDailyPath,
  optionSchwabBarsTrackExit,
  performanceFocusWindow,
  positionTicker,
  tickerOpenMark,
  weekdayDates,
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

test('ticker open mark joins the last point so headline is dividends plus MTM', () => {
  const series = [
    point({ date: '2026-04-07', daily_dividends: 34.48 }),
    point({ date: '2026-08-06', daily_dividends: 33.05 }),
    point({ date: '2026-08-29' }),
  ];
  const mark = { equity_pnl: 174, option_pnl: 50 };
  const composed = composeSeries(series, ALL, includedOpenMark(mark, ALL));
  assert.equal(composed[1]?.cumulative, 67.53);
  assert.equal(composed[2]?.daily, 224);
  assert.equal(composed[2]?.cumulative, 291.53);
  const totals = composeTotals(series, ALL, mark);
  assert.equal(totals.period, 291.53);
  assert.equal(totals.stocks, 174);
  assert.equal(totals.options, 50);
  assert.equal(totals.dividends, 67.53);

  const tlt = composeTotals(series, ALL, { equity_pnl: -438, option_pnl: 0 });
  assert.equal(tlt.stocks, -438);
  assert.equal(tlt.options, 0);
  assert.equal(tlt.period, -370.47);

  assert.equal(composeTotals(series, { ...ALL, stocks: false, options: false }, mark).period, 67.53);
  assert.equal(
    composeTotals(series, { ...ALL, stocks: false }, mark).period,
    67.53 + 50,
  );
  assert.equal(
    includedOpenMark({ equity_pnl: 174, option_pnl: 50 }, ALL),
    224,
  );
  assert.equal(
    includedOpenMark({ equity_pnl: 174, option_pnl: 50 }, { ...ALL, stocks: false }),
    50,
  );
});

test('applyEquityMarkPath follows daily closes instead of a one-day cliff', () => {
  const sparse = [
    point({ date: '2026-01-01' }),
    point({ date: '2026-04-07', daily_dividends: 34.48 }),
    point({ date: '2026-07-07', daily_dividends: 31.8 }),
    point({ date: '2026-08-29' }),
  ];
  const ohlc = [
    { date: '2026-03-18', close: 87.26 },
    { date: '2026-07-06', close: 85.45 },
    { date: '2026-07-07', close: 84.55 },
    { date: '2026-08-28', close: 83.22 },
  ];
  const lot = {
    opened: '2026-03-18',
    quantity: 100,
    average_price: 87.26,
    live_pnl: -438,
  };
  const { points: path, painted, inWindowMtm } = applyEquityMarkPath(
    sparse,
    ohlc,
    lot,
    '2026-01-01',
    '2026-08-29',
  );
  assert.equal(painted, true);
  const jul6 = path.find((p) => p.date === '2026-07-06');
  const last = path.at(-1);
  assert.ok(jul6);
  assert.notEqual(last?.date, '2026-07-06');
  assert.equal(last?.date, '2026-08-29');
  const jul6Equity = jul6!.daily_equity_pnl ?? 0;
  assert.ok(Math.abs(jul6Equity) < 200, '7/6 must not carry the whole open mark');
  const start = lot.live_pnl - inWindowMtm;
  const totals = composeTotals(path, ALL, { equity_pnl: lot.live_pnl - inWindowMtm, option_pnl: 0 }, {
    startCumulative: start,
    lastPointPnl: 0,
  });
  assert.equal(totals.stocks, -438);
  assert.equal(totals.period, Math.round((34.48 + 31.8 - 438) * 100) / 100);

  assert.equal(applyEquityMarkPath(sparse, [], lot, '2026-01-01', '2026-08-29').painted, false);

  const fromPos = equityOpenLot(
    [{
      id: 'tlt',
      symbol: 'TLT',
      underlying: null,
      description: 'iShares 20+ Year Treasury Bond ETF',
      asset_type: 'COLLECTIVE_INVESTMENT',
      quantity: 100,
      average_price: 87.26,
      market_value: 8288,
      day_pnl: null,
      open_pnl: -438,
    }],
    [{
      id: '1',
      activity_id: 1,
      trade_date: '2026-03-18T15:00:00.000Z',
      settlement_date: null,
      description: 'BOUGHT TLT',
      status: 'VALID',
      activity_type: 'EXECUTION',
      net_amount: -8726,
      symbol: 'TLT',
      underlying: null,
      asset_type: 'COLLECTIVE_INVESTMENT',
      quantity: 100,
      price: 87.26,
      cost: -8726,
      fees: 0,
      side: 'buy',
      position_effect: 'OPENING',
      order_id: null,
      position_id: null,
    }],
    'TLT',
  );
  assert.equal(fromPos?.opened, '2026-03-18');
  assert.equal(fromPos?.live_pnl, -438);
});

test('applyEquityMarkPath first in-range bar is incremental when the lot opened earlier', () => {
  const { points: path, painted } = applyEquityMarkPath(
    [point({ date: '2026-08-01' }), point({ date: '2026-08-29' })],
    [
      { date: '2026-07-31', close: 82.25 },
      { date: '2026-08-03', close: 82.19 },
      { date: '2026-08-28', close: 83.22 },
    ],
    {
      opened: '2026-03-18',
      quantity: 100,
      average_price: 87.26,
      live_pnl: -438,
    },
    '2026-08-01',
    '2026-08-29',
  );
  assert.equal(painted, true);
  const first = path.find((p) => p.date === '2026-08-03');
  assert.ok(first);
  assert.equal(first!.daily_equity_pnl, Math.round(100 * (82.19 - 82.25) * 100) / 100);
  assert.notEqual(first!.daily_equity_pnl, Math.round(100 * (82.19 - 87.26) * 100) / 100);
});

test('tickerOpenMark matches ETF and OCC option rows and derives missing open_pnl', () => {
  const mark = tickerOpenMark(
    [
      {
        id: 'tlt',
        symbol: 'TLT',
        underlying: null,
        description: 'iShares 20+ Year Treasury Bond ETF',
        asset_type: 'COLLECTIVE_INVESTMENT',
        quantity: 100,
        average_price: 87.26,
        market_value: 8900,
        day_pnl: null,
        open_pnl: null,
      },
      {
        id: 'car-put',
        symbol: 'CAR   260618P00390000',
        underlying: 'CAR',
        asset_type: 'OPTION',
        description: null,
        quantity: -1,
        average_price: 2.5,
        market_value: -200,
        day_pnl: null,
        open_pnl: 50,
      },
    ],
    'TLT',
  );
  assert.equal(mark?.count, 1);
  assert.equal(mark?.equity_pnl, 8900 - 87.26 * 100);
  assert.equal(mark?.option_pnl, 0);
  assert.equal(tickerOpenMark([], 'TLT'), null);
  assert.equal(tickerOpenMark([], null), null);
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
  assert.equal(rows[0]?.option_right, 'put');
  assert.equal(rows[0]?.strike, 390);
  assert.equal(rows[0]?.price, 2.5);
  assert.equal(rows[1]?.kind, 'dividend');
  assert.equal(rows[1]?.option_right, null);
  assert.equal(rows[1]?.strike, null);
  assert.equal(rows[2]?.kind, 'stock');
  assert.equal(rows[2]?.option_right, null);
  assert.equal(rows[2]?.strike, null);
  assert.equal(rows[2]?.realized_pnl, 40);
  assert.equal(rows[2]?.prior_open, true);

  const optionsOnly = filterActivity(rows, { stocks: false, options: true, dividends: false, fees: false });
  assert.equal(optionsOnly.length, 1);
  assert.equal(optionsOnly[0]?.kind, 'option');

  const feesOnly = filterActivity(rows, { stocks: false, options: false, dividends: false, fees: true });
  assert.equal(feesOnly.length, 1);
  assert.equal(feesOnly[0]?.fees, -1);
});

test('buildActivityRows includes assignment synth fills that are not in trades', () => {
  const rows = buildActivityRows({
    trades: [],
    fills: [{
      id: 'synth-assign-stock-opt-1',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close (CAR   260618P00390000)',
      side: 'buy',
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 5020.8,
      opened: '2026-01-02',
      prior_open: false,
      asset_type: 'OPTION',
    }],
    distributions: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'option');
  assert.equal(rows[0]?.option_right, 'put');
  assert.equal(rows[0]?.strike, 390);
  assert.equal(rows[0]?.price, 0);
  assert.equal(rows[0]?.realized_pnl, 5020.8);
  assert.equal(rows[0]?.id, 'fill-synth-assign-stock-opt-1');
});

test('performanceFocusWindow fits the chart to the CAR hold without changing YTD data', () => {
  const points = [
    { date: '2026-01-01', daily: 0 },
    { date: '2026-04-23', daily: 4800 },
    { date: '2026-05-08', daily: 220.8 },
    { date: '2026-08-29', daily: 0 },
  ];
  const focus = performanceFocusWindow(
    points,
    [{ date: '2026-04-22' }, { date: '2026-05-08' }],
    [
      { opened: '2026-04-22', closed: '2026-05-08' },
      { opened: '2026-04-22', closed: '2026-05-08' },
    ],
    '2026-01-01',
    '2026-08-29',
  );
  assert.deepEqual(focus, { start: '2026-04-22', end: '2026-05-08' });
  assert.equal(points.reduce((sum, row) => sum + row.daily, 0), 5020.8);
});

test('performanceFocusWindow keeps an open option hold through the range end', () => {
  assert.deepEqual(
    performanceFocusWindow(
      [{ date: '2026-08-29', daily: 14 }],
      [{ date: '2026-08-10' }],
      [{ opened: '2026-08-10', closed: null }],
      '2026-08-01',
      '2026-08-29',
    ),
    { start: '2026-08-10', end: '2026-08-29' },
  );
});

test('parseOccContract reads strike and put/call from padded OCC', () => {
  const put = parseOccContract('CAR   260618P00390000');
  assert.equal(put?.root, 'CAR');
  assert.equal(put?.right, 'P');
  assert.equal(put?.strike, 390);
  const call = parseOccContract('AAPL260918C00150500');
  assert.equal(call?.right, 'C');
  assert.equal(call?.strike, 150.5);
  assert.equal(parseOccContract('CAR'), null);
});

test('applyOptionMarkPath spreads the CAR assignment instead of a one-day rocket', () => {
  const sparse = [
    point({ date: '2026-01-01' }),
    point({ date: '2026-05-08', daily_option_pnl: 29507.12, daily_equity_pnl: -24486.32, daily_pnl: 5020.8 }),
    point({ date: '2026-08-29' }),
  ];
  const fills = [
    {
      id: 'synth-390',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close',
      side: 'buy' as const,
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 8309.17,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'close-500',
      date: '2026-05-08',
      symbol: 'CAR   260618P00500000',
      underlying: 'CAR',
      description: '',
      side: 'sell' as const,
      quantity: 1,
      price: 354.6,
      net_amount: 35458.61,
      fees: -1.39,
      realized_pnl: 21197.95,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'stock-sale',
      date: '2026-05-08',
      symbol: 'CAR',
      underlying: null,
      description: '',
      side: 'sell' as const,
      quantity: 100,
      price: 145.14,
      net_amount: 14513.68,
      fees: -0.32,
      realized_pnl: -24486.32,
      opened: '2026-05-08',
      prior_open: false,
      asset_type: 'EQUITY',
    },
  ];
  const lots = optionLotsFromFills(fills);
  assert.equal(lots.length, 2);
  const assigned = lots.find((l) => l.quantity < 0);
  assert.ok(assigned && Math.abs(assigned.average_price - 83.0917) < 0.01);
  assert.equal(assigned?.target_pnl, -16177.15);
  assert.ok(Math.abs((assigned?.exit_price ?? 0) - 244.8632) < 0.01);
  assert.equal(assigned?.assignment_equity_pnl, -24486.32);
  assert.ok(lots.some((l) => l.quantity > 0 && Math.abs(l.average_price - 142.6205) < 0.01));

  const first = Date.parse('2026-04-01T12:00:00Z');
  const penultimate = Date.parse('2026-05-07T12:00:00Z');
  const carOhlc = Array.from({ length: 20 }, (_, index) => ({
    date: new Date(first + ((penultimate - first) * index) / 19).toISOString().slice(0, 10),
    close: 300 - (150 * index) / 19,
  }));
  carOhlc.push({ date: '2026-05-08', close: 145.14 });
  // A pre-open OTM print used to reject the whole intrinsic path and leave
  // the May 8 rocket in place.
  carOhlc.unshift({ date: '2026-01-15', close: 420 });

  const { points: path, painted, closedPnl } = applyOptionMarkPath(
    densifyWithOhlc(sparse, carOhlc, '2026-01-01', '2026-08-29'),
    {},
    lots,
    '2026-01-01',
    '2026-08-29',
    carOhlc,
  );
  assert.equal(painted, true);
  assert.equal(closedPnl, 5020.8);
  const may8 = path.find((p) => p.date === '2026-05-08');
  const holdingDays = path.filter((p) => p.date >= '2026-04-01' && p.date < '2026-05-08');
  assert.ok(
    holdingDays.some((p) => Math.abs(p.daily_option_pnl ?? 0) > 0),
    'spread gain must accrue during the hold',
  );
  assert.ok(
    Math.abs(may8!.daily_option_pnl ?? 0) < 500,
    'May 8 must be the small spread/fill difference, not the whole close',
  );
  const optionSum = path.reduce((s, p) => s + (p.daily_option_pnl ?? 0), 0);
  assert.equal(Math.round(optionSum * 100) / 100, 5020.8);
  assert.equal(may8!.daily_equity_pnl, 0);
  assert.ok(Math.abs(may8!.daily_pnl ?? 0) < 500);
});

test('optionSchwabBarsTrackExit rejects flat stale prints before the exit', () => {
  assert.equal(
    optionSchwabBarsTrackExit(
      [
        { date: '2026-04-01', close: 83.09 },
        { date: '2026-04-15', close: 83.09 },
        { date: '2026-05-07', close: 83.09 },
      ],
      83.09,
      244.86,
    ),
    false,
  );
  assert.equal(
    optionSchwabBarsTrackExit(
      [
        { date: '2026-04-01', close: 90 },
        { date: '2026-04-15', close: 160 },
        { date: '2026-05-07', close: 220 },
      ],
      83.09,
      244.86,
    ),
    true,
  );
  assert.equal(optionSchwabBarsTrackExit([{ date: '2026-04-01', close: 83 }], 83, 244), false);
});

test('applyOptionMarkPath ignores flat Schwab option prints and uses intrinsic', () => {
  const sparse = [
    point({ date: '2026-01-01' }),
    point({ date: '2026-05-08', daily_option_pnl: 29507.12, daily_equity_pnl: -24486.32, daily_pnl: 5020.8 }),
    point({ date: '2026-08-29' }),
  ];
  const fills = [
    {
      id: 'synth-390',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close',
      side: 'buy' as const,
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 8309.17,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'close-500',
      date: '2026-05-08',
      symbol: 'CAR   260618P00500000',
      underlying: 'CAR',
      description: '',
      side: 'sell' as const,
      quantity: 1,
      price: 354.6,
      net_amount: 35458.61,
      fees: -1.39,
      realized_pnl: 21197.95,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'stock-sale',
      date: '2026-05-08',
      symbol: 'CAR',
      underlying: null,
      description: '',
      side: 'sell' as const,
      quantity: 100,
      price: 145.14,
      net_amount: 14513.68,
      fees: -0.32,
      realized_pnl: -24486.32,
      opened: '2026-05-08',
      prior_open: false,
      asset_type: 'EQUITY',
    },
  ];
  const lots = optionLotsFromFills(fills);
  const first = Date.parse('2026-04-01T12:00:00Z');
  const penultimate = Date.parse('2026-05-07T12:00:00Z');
  const carOhlc = Array.from({ length: 20 }, (_, index) => ({
    date: new Date(first + ((penultimate - first) * index) / 19).toISOString().slice(0, 10),
    close: 300 - (150 * index) / 19,
  }));
  carOhlc.push({ date: '2026-05-08', close: 145.14 });

  // Stale last-trade marks: enough bars to pass the old length>=2 gate, but
  // never leave the entry print — the live CAR bug on Schwab option history.
  const flatOptionOhlc = {
    CAR260618P00390000: [
      { date: '2026-04-01', close: 83.09 },
      { date: '2026-04-15', close: 83.09 },
      { date: '2026-05-01', close: 83.09 },
      { date: '2026-05-07', close: 83.09 },
    ],
    CAR260618P00500000: [
      { date: '2026-04-01', close: 142.62 },
      { date: '2026-04-15', close: 142.62 },
      { date: '2026-05-01', close: 142.62 },
      { date: '2026-05-07', close: 142.62 },
    ],
  };

  const { points: path, painted, closedPnl } = applyOptionMarkPath(
    densifyWithOhlc(sparse, carOhlc, '2026-01-01', '2026-08-29'),
    flatOptionOhlc,
    lots,
    '2026-01-01',
    '2026-08-29',
    carOhlc,
  );
  assert.equal(painted, true);
  assert.equal(closedPnl, 5020.8);
  const may8 = path.find((p) => p.date === '2026-05-08');
  const holdingDays = path.filter((p) => p.date >= '2026-04-01' && p.date < '2026-05-08');
  assert.ok(
    holdingDays.some((p) => Math.abs(p.daily_option_pnl ?? 0) > 0),
    'flat Schwab option prints must not block the intrinsic hold path',
  );
  assert.ok(
    Math.abs(may8!.daily_option_pnl ?? 0) < 500,
    'May 8 must not keep the whole close when Schwab option marks were flat',
  );
  const optionSum = path.reduce((s, p) => s + (p.daily_option_pnl ?? 0), 0);
  assert.equal(Math.round(optionSum * 100) / 100, 5020.8);
  assert.equal(may8!.daily_equity_pnl, 0);
});

test('applyOptionMarkPath linear-spreads assignment when no OHLC is available', () => {
  const sparse = [
    point({ date: '2026-01-01' }),
    point({ date: '2026-05-08', daily_option_pnl: 29507.12, daily_equity_pnl: -24486.32, daily_pnl: 5020.8 }),
    point({ date: '2026-08-29' }),
  ];
  const fills = [
    {
      id: 'synth-390',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close',
      side: 'buy' as const,
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 8309.17,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'close-500',
      date: '2026-05-08',
      symbol: 'CAR   260618P00500000',
      underlying: 'CAR',
      description: '',
      side: 'sell' as const,
      quantity: 1,
      price: 354.6,
      net_amount: 35458.61,
      fees: -1.39,
      realized_pnl: 21197.95,
      opened: '2026-04-01',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'stock-sale',
      date: '2026-05-08',
      symbol: 'CAR',
      underlying: null,
      description: '',
      side: 'sell' as const,
      quantity: 100,
      price: 145.14,
      net_amount: 14513.68,
      fees: -0.32,
      realized_pnl: -24486.32,
      opened: '2026-05-08',
      prior_open: false,
      asset_type: 'EQUITY',
    },
  ];
  const { points: path, painted, closedPnl } = applyOptionMarkPath(
    sparse,
    {},
    optionLotsFromFills(fills),
    '2026-01-01',
    '2026-08-29',
    [],
  );
  assert.equal(painted, true);
  assert.equal(closedPnl, 5020.8);
  const holdWeekdays = weekdayDates('2026-04-01', '2026-05-07');
  assert.ok(holdWeekdays.length >= 20);
  const holdingDays = path.filter((p) => p.date >= '2026-04-01' && p.date < '2026-05-08');
  assert.ok(holdingDays.length >= holdWeekdays.length);
  assert.ok(
    holdingDays.some((p) => Math.abs(p.daily_option_pnl ?? 0) > 0),
    'linear fallback must accrue during the hold',
  );
  const may8 = path.find((p) => p.date === '2026-05-08');
  assert.ok(
    Math.abs(may8!.daily_option_pnl ?? 0) < 1500,
    'May 8 must not keep the whole FIFO close',
  );
  assert.equal(may8!.daily_equity_pnl, 0);
  const optionSum = path.reduce((s, p) => s + (p.daily_option_pnl ?? 0), 0);
  assert.equal(Math.round(optionSum * 100) / 100, 5020.8);
});

test('applyOptionMarkPath follows the live CAR crash on Schwab underlying', () => {
  // Live book: opened 2026-04-22, stock crashed 444→229 on 04-23, assigned 05-08.
  // Schwab option history is empty; marks must come from Schwab underlying
  // intrinsic — most of the +$5020.80 accrues on the crash, not May 8.
  const sparse = [
    point({ date: '2026-01-01' }),
    point({ date: '2026-05-08', daily_option_pnl: 29507.12, daily_equity_pnl: -24486.32, daily_pnl: 5020.8 }),
    point({ date: '2026-08-29' }),
  ];
  const fills = [
    {
      id: 'synth-390',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close',
      side: 'buy' as const,
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 8309.17,
      opened: '2026-04-22',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'close-500',
      date: '2026-05-08',
      symbol: 'CAR   260618P00500000',
      underlying: 'CAR',
      description: '',
      side: 'sell' as const,
      quantity: 1,
      price: 354.6,
      net_amount: 35458.61,
      fees: -1.39,
      realized_pnl: 21197.95,
      opened: '2026-04-22',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'stock-sale',
      date: '2026-05-08',
      symbol: 'CAR',
      underlying: null,
      description: '',
      side: 'sell' as const,
      quantity: 100,
      price: 145.14,
      net_amount: 14513.68,
      fees: -0.32,
      realized_pnl: -24486.32,
      opened: '2026-05-08',
      prior_open: false,
      asset_type: 'EQUITY',
    },
  ];
  const carOhlc = [
    { date: '2026-04-22', close: 443.94 },
    { date: '2026-04-23', close: 229.14 },
    { date: '2026-04-24', close: 204 },
    { date: '2026-04-27', close: 187.07 },
    { date: '2026-04-28', close: 182.005 },
    { date: '2026-04-29', close: 181.15 },
    { date: '2026-04-30', close: 180.67 },
    { date: '2026-05-01', close: 185.55 },
    { date: '2026-05-04', close: 168.295 },
    { date: '2026-05-05', close: 160.1 },
    { date: '2026-05-06', close: 164.23 },
    { date: '2026-05-07', close: 154.06 },
    { date: '2026-05-08', close: 145.75 },
  ];
  const emptyOptionOhlc = {
    CAR260618P00390000: [] as Array<{ date: string; close: number }>,
    CAR260618P00500000: [] as Array<{ date: string; close: number }>,
  };
  const { points: path, painted, closedPnl } = applyOptionMarkPath(
    densifyWithOhlc(sparse, carOhlc, '2026-01-01', '2026-08-29'),
    emptyOptionOhlc,
    optionLotsFromFills(fills),
    '2026-01-01',
    '2026-08-29',
    carOhlc,
  );
  assert.equal(painted, true);
  assert.equal(closedPnl, 5020.8);
  const apr23 = path.find((p) => p.date === '2026-04-23');
  const may8 = path.find((p) => p.date === '2026-05-08');
  const crashMove = Math.abs(apr23?.daily_option_pnl ?? 0);
  const assignMove = Math.abs(may8?.daily_option_pnl ?? 0);
  assert.ok(crashMove > 2000, `crash day must carry the bulk MTM, got ${crashMove}`);
  assert.ok(assignMove < 500, `May 8 must not keep the FIFO rocket, got ${assignMove}`);
  assert.equal(may8!.daily_equity_pnl, 0);
  const optionSum = path.reduce((s, p) => s + (p.daily_option_pnl ?? 0), 0);
  assert.equal(Math.round(optionSum * 100) / 100, 5020.8);
});

test('optionLegDailyPath exposes per-session marks for a CAR put leg', () => {
  const fills = [
    {
      id: 'synth-390',
      date: '2026-05-08',
      symbol: 'CAR   260618P00390000',
      underlying: 'CAR',
      description: 'Option assignment close',
      side: 'buy' as const,
      quantity: 1,
      price: 0,
      net_amount: 0,
      fees: 0,
      realized_pnl: 8309.17,
      opened: '2026-04-22',
      prior_open: false,
      asset_type: 'OPTION',
    },
    {
      id: 'stock-sale',
      date: '2026-05-08',
      symbol: 'CAR',
      underlying: null,
      description: '',
      side: 'sell' as const,
      quantity: 100,
      price: 145.14,
      net_amount: 14513.68,
      fees: -0.32,
      realized_pnl: -24486.32,
      opened: '2026-05-08',
      prior_open: false,
      asset_type: 'EQUITY',
    },
  ];
  const lot = optionLotsFromFills(fills).find((l) => l.quantity < 0);
  assert.ok(lot);
  const carOhlc = [
    { date: '2026-04-22', close: 443.94 },
    { date: '2026-04-23', close: 229.14 },
    { date: '2026-05-07', close: 154.06 },
    { date: '2026-05-08', close: 145.75 },
  ];
  const path = optionLegDailyPath(
    lot!,
    {},
    '2026-01-01',
    '2026-08-29',
    carOhlc,
  );
  assert.ok(path.length >= 3);
  assert.equal(path[0]?.source, 'intrinsic');
  assert.equal(path[0]?.date, '2026-04-22');
  // Open day: fill → first intrinsic (OTM short put → mark 0) books the premium.
  assert.ok(Math.abs((path[0]?.daily_pnl ?? 0) - 8309.17) < 1);
  const crash = path.find((p) => p.date === '2026-04-23');
  assert.ok(crash && crash.daily_pnl < -1000, 'crash day must mark the short put up');
  assert.equal(Math.round((path.at(-1)?.cumulative_pnl ?? 0) * 100) / 100, lot!.target_pnl);
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
