import assert from 'node:assert/strict';
import test from 'node:test';
import { createChartScene, renderChartSvg, type ChartScene } from '@tanstack/charts';
import type { QueryResult } from '../api.ts';
import type { ChartSpec } from '../chartSpec.ts';
import { asPlotNumber, buildQueryPlotRows, defineQueryChart } from './queryChart.ts';
import { definePnlChart } from './pnlChart.ts';
import { defineTickerChart, tickerCloses } from './tickerChart.ts';

function nodeKinds(nodes: ChartScene['nodes'], kinds = new Set<string>()): Set<string> {
  for (const node of nodes) {
    kinds.add(node.kind);
    if ('children' in node && Array.isArray(node.children)) {
      nodeKinds(node.children, kinds);
    }
  }
  return kinds;
}

function result(columns: string[], rows: Record<string, unknown>[]): QueryResult {
  return { columns, rows, row_count: rows.length };
}

test('asPlotNumber accepts numeric strings and rejects blanks', () => {
  assert.equal(asPlotNumber(12.5), 12.5);
  assert.equal(asPlotNumber(' 4 '), 4);
  assert.equal(asPlotNumber(''), null);
  assert.equal(asPlotNumber(null), null);
});

test('buildQueryPlotRows emits long-form series rows sorted by numeric x', () => {
  const spec: ChartSpec = {
    kind: 'line',
    x: 'strike',
    y: 'implied_vol',
    series: 'expiration',
  };
  const data = buildQueryPlotRows(
    result(
      ['strike', 'implied_vol', 'expiration'],
      [
        { strike: 110, implied_vol: 0.32, expiration: '2026-10-16' },
        { strike: 100, implied_vol: 0.28, expiration: '2026-09-18' },
        { strike: 100, implied_vol: 0.30, expiration: '2026-10-16' },
        { strike: 110, implied_vol: 'bad', expiration: '2026-09-18' },
      ],
    ),
    spec,
  );
  assert.equal(data.numericX, true);
  assert.deepEqual(data.seriesNames, ['2026-09-18', '2026-10-16']);
  assert.deepEqual(data.rows, [
    { x: 100, y: 0.28, series: '2026-09-18' },
    { x: 100, y: 0.30, series: '2026-10-16' },
    { x: 110, y: 0.32, series: '2026-10-16' },
  ]);
});

test('buildQueryPlotRows keeps the last value per x and series', () => {
  const spec: ChartSpec = { kind: 'bar', x: 'ticker', y: 'pct_chg' };
  const data = buildQueryPlotRows(
    result(
      ['ticker', 'pct_chg'],
      [
        { ticker: 'SPY', pct_chg: 1.2 },
        { ticker: 'XBI', pct_chg: 2.1 },
        { ticker: 'XBI', pct_chg: 2.4 },
      ],
    ),
    spec,
  );
  assert.deepEqual(data.rows, [
    { x: 'SPY', y: 1.2, series: 'pct_chg' },
    { x: 'XBI', y: 2.4, series: 'pct_chg' },
  ]);
  assert.doesNotThrow(() => {
    createChartScene(
      defineQueryChart({
        rows: data.rows,
        kind: 'bar',
        numericX: data.numericX,
        seriesNames: data.seriesNames,
      }),
      { width: 640, height: 280 },
    );
  });
});

test('query line chart scene emits one point per valid row', () => {
  const spec: ChartSpec = { kind: 'line', x: 'strike', y: 'implied_vol' };
  const plot = buildQueryPlotRows(
    result(
      ['strike', 'implied_vol'],
      [
        { strike: 90, implied_vol: 0.4 },
        { strike: 100, implied_vol: 0.3 },
        { strike: 110, implied_vol: 0.35 },
      ],
    ),
    spec,
  );
  const scene = createChartScene(
    defineQueryChart({
      rows: plot.rows,
      kind: 'line',
      numericX: plot.numericX,
      seriesNames: plot.seriesNames,
    }),
    { width: 640, height: 280 },
  );
  assert.equal(scene.points.length, 3);
  assert.ok(nodeKinds(scene.nodes).has('polyline'));
  assert.match(renderChartSvg(scene, { ariaLabel: 'IV vs strike' }), /<svg /);
});

test('ticker chart scene includes the close path and optional spot rule', () => {
  const rows = tickerCloses([
    { date: '2026-01-02', open: 10, high: 11, low: 9, close: 10.5, volume: 1 },
    { date: '2026-01-05', open: 10.5, high: 12, low: 10, close: 11.2, volume: 1 },
    { date: '2026-01-06', open: 11, high: 12, low: 10, close: null, volume: 1 },
  ]);
  assert.equal(rows.length, 2);
  const scene = createChartScene(
    defineTickerChart({ rows, spot: 11, isIntraday: false }),
    { width: 640, height: 256 },
  );
  assert.equal(scene.points.length, 3);
  const kinds = nodeKinds(scene.nodes);
  assert.ok(kinds.has('polyline'));
  assert.ok(kinds.has('rule'));
});

test('wide sector table melts into one series per ticker', () => {
  const spec: ChartSpec = {
    kind: 'line',
    x: 'trade_date',
    y: 'xlk',
    series: 'xlk',
    title: 'Sector rotation — XLK vs XLF vs XLE vs XLU (8/31–9/4)',
  };
  const data = buildQueryPlotRows(
    result(
      ['trade_date', 'xlk', 'xlf', 'xle', 'xlu'],
      [
        { trade_date: '2026-08-31', xlk: 200, xlf: 50, xle: 90, xlu: 70 },
        { trade_date: '2026-09-01', xlk: 210, xlf: 52, xle: 88, xlu: 71 },
        { trade_date: '2026-09-02', xlk: 205, xlf: 53, xle: 91, xlu: 72 },
      ],
    ),
    spec,
  );
  assert.deepEqual(data.seriesNames.sort(), ['XLE', 'XLF', 'XLK', 'XLU']);
  assert.equal(data.rebased, true);
  assert.equal(data.yLabel, 'Indexed (first = 100)');
  const xlk = data.rows.filter((row) => row.series === 'XLK');
  assert.equal(xlk[0]?.y, 100);
  assert.equal(xlk[1]?.y, 105);
});

test('index closes on incomparable scales rebase to 100', () => {
  const spec: ChartSpec = {
    kind: 'line',
    x: 'date',
    y: 'close',
    series: 'symbol',
    title: 'Index closes: SPY / QQQ / IWM',
  };
  const data = buildQueryPlotRows(
    result(
      ['date', 'symbol', 'close'],
      [
        { date: '2026-08-24', symbol: 'SPY', close: 770 },
        { date: '2026-08-25', symbol: 'SPY', close: 777 },
        { date: '2026-08-24', symbol: 'IWM', close: 220 },
        { date: '2026-08-25', symbol: 'IWM', close: 222 },
      ],
    ),
    spec,
  );
  assert.equal(data.rebased, true);
  assert.deepEqual(
    data.rows.filter((row) => row.series === 'SPY').map((row) => row.y),
    [100, 100.9090909090909],
  );
});

test('drops series=value on a single yield line', () => {
  const spec: ChartSpec = { kind: 'line', x: 'date', y: 'value', series: 'value', title: 'US 10Y' };
  const data = buildQueryPlotRows(
    result(
      ['date', 'value'],
      [
        { date: '2026-06-01', value: 4.2 },
        { date: '2026-07-01', value: 4.3 },
        { date: '2026-08-01', value: 4.1 },
        { date: '2026-09-01', value: 4.4 },
        { date: '2026-09-02', value: 4.35 },
      ],
    ),
    spec,
  );
  assert.deepEqual(data.seriesNames, ['value']);
  assert.equal(data.kind, 'line');
  assert.equal(data.rebased, false);
});

test('one point per name on a line becomes a scatter', () => {
  const spec: ChartSpec = { kind: 'line', x: 'startpx', y: 'endpx', series: 'symbol', title: 'endpx vs startpx' };
  const data = buildQueryPlotRows(
    result(
      ['symbol', 'startpx', 'endpx'],
      [
        { symbol: 'XLK', startpx: 230, endpx: 228 },
        { symbol: 'XLE', startpx: 90, endpx: 94 },
        { symbol: 'XLF', startpx: 50, endpx: 51 },
        { symbol: 'XLU', startpx: 70, endpx: 72 },
        { symbol: 'XLV', startpx: 140, endpx: 138 },
      ],
    ),
    spec,
  );
  assert.equal(data.kind, 'scatter');
  assert.equal(data.rows.length, 5);
  assert.deepEqual(data.seriesNames.sort(), ['XLE', 'XLF', 'XLK', 'XLU', 'XLV']);
});

test('volume bar with open interest becomes grouped bars', () => {
  const spec: ChartSpec = { kind: 'bar', x: 'symbol', y: 'volume', title: 'volume vs open interest' };
  const data = buildQueryPlotRows(
    result(
      ['symbol', 'volume', 'open_interest', 'delta_pct'],
      [
        { symbol: 'NVDA', volume: 40_000, open_interest: 12_000, delta_pct: 18 },
        { symbol: 'TSLA', volume: 22_000, open_interest: 8_000, delta_pct: 22 },
      ],
    ),
    spec,
  );
  assert.deepEqual(data.seriesNames, ['Volume', 'Open interest']);
  assert.equal(data.kind, 'bar');
  assert.equal(data.rows.length, 4);
});

test('treasury tenors sort in maturity order', () => {
  const spec: ChartSpec = { kind: 'line', x: 'x', y: 'y', title: 'US Treasury nominal curve' };
  const data = buildQueryPlotRows(
    result(
      ['x', 'y'],
      [
        { x: '10Y', y: 4.2 },
        { x: '2Y', y: 3.6 },
        { x: '30Y', y: 4.5 },
        { x: '5Y', y: 3.9 },
      ],
    ),
    spec,
  );
  assert.deepEqual(data.rows.map((row) => row.x), ['2Y', '5Y', '10Y', '30Y']);
});

test('daily P&L scene paints signed bars and a zero rule', () => {
  const scene = createChartScene(
    definePnlChart({
      series: [
        { date: '2026-08-01', daily: 120, cumulative: 120 },
        { date: '2026-08-04', daily: -40, cumulative: 80 },
        { date: '2026-08-05', daily: 15, cumulative: 95 },
      ],
      markers: [
        { date: '2026-08-01', daily: 120, cumulative: 120, kind: 'stock', label: 'AAPL' },
      ],
      metric: 'daily',
      domain: [-50, 140],
    }),
    { width: 720, height: 280 },
  );
  assert.ok(scene.points.length >= 3);
  const kinds = nodeKinds(scene.nodes);
  assert.ok(kinds.has('rect'));
  assert.ok(kinds.has('rule'));
});
