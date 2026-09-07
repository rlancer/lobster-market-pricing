import assert from 'node:assert/strict';
import test from 'node:test';
import type { VixCurvePoint } from '../api.ts';
import {
  defineVixTermChart,
  vixTermFutureLeg,
  vixTermPlotRows,
  vixTermSpotLevel,
} from './vixTermChart.ts';

function pt(tenor: number, last: number, label: string): VixCurvePoint {
  return {
    tenor,
    kind: tenor === 0 ? 'spot' : 'future',
    symbol: tenor === 0 ? '^VIX' : `M${tenor}`,
    label,
    last,
    prev: last,
    change: 0,
    change_pct: 0,
    expiration: null,
    dte: null,
    volume: null,
    open_interest: null,
    bid: null,
    ask: null,
    settle: last,
  };
}

test('vixTermPlotRows overlay selected settlement dates on constant-maturity tenors', () => {
  const rows = vixTermPlotRows({
    primaryLabel: 'Live',
    curve: [pt(0, 15, 'Spot'), pt(1, 16.4, "Sep'26"), pt(2, 17.1, "Oct'26")],
    overlayDates: ['2026-09-04'],
    history: [
      { date: '2026-09-04', points: [pt(0, 16, 'Spot'), pt(1, 17, "Sep'26")] },
      { date: '2026-09-03', points: [pt(0, 18, 'Spot'), pt(1, 19, "Sep'26")] },
    ],
  });
  assert.deepEqual(
    rows.map((row) => `${row.series}:${row.x}:${row.y}`),
    ['Live:Spot:15', '2026-09-04:Spot:16', 'Live:M1:16.4', '2026-09-04:M1:17', 'Live:M2:17.1'],
  );
  assert.equal(vixTermSpotLevel(rows, 'Live'), 15);
  assert.deepEqual(
    vixTermFutureLeg(rows).map((row) => `${row.series}:${row.x}`),
    ['Live:M1', '2026-09-04:M1', 'Live:M2'],
  );
  const chart = defineVixTermChart(rows, 'Live');
  assert.ok(chart);
});
