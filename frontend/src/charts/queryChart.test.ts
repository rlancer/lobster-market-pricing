import assert from 'node:assert/strict';
import test from 'node:test';
import { createChartScene } from '@tanstack/charts';
import type { QueryResult } from '../api.ts';
import type { ChartSpec } from '../chartSpec.ts';
import { asPlotNumber, buildQueryPlotRows, defineQueryChart } from './queryChart.ts';
import { definePnlChart } from './pnlChart.ts';
import { defineTickerChart, tickerCloses } from './tickerChart.ts';

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
  assert.ok(scene.nodes.some((node) => node.kind === 'polyline' || node.kind === 'line'));
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
  assert.equal(scene.points.filter((point) => point.markId?.includes('line') || point.yValue === 11.2 || point.yValue === 10.5).length >= 2, true);
  assert.ok(scene.nodes.some((node) => node.kind === 'rule' || node.kind === 'line'));
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
  assert.ok(scene.nodes.some((node) => node.kind === 'rect' || node.kind === 'bar'));
});
