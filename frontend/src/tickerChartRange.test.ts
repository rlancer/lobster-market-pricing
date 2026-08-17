import assert from 'node:assert/strict';
import test from 'node:test';
import type { OhlcBar } from './api.ts';
import { rangeMove, sliceBars } from './tickerChartRange.ts';

function bar(date: string, close: number | null): OhlcBar {
  return { date, open: close, high: close, low: close, close, volume: 1 };
}

test('sliceBars keeps the trailing window for 1M / 3M', () => {
  const bars = Array.from({ length: 100 }, (_, i) => bar(`2026-01-${String(i + 1).padStart(2, '0')}`, i));
  const oneMonth = sliceBars(bars, '1M');
  assert.equal(oneMonth.length, 22);
  assert.equal(oneMonth[0]?.close, 78);
  assert.equal(oneMonth.at(-1)?.close, 99);

  const threeMonth = sliceBars(bars, '3M');
  assert.equal(threeMonth.length, 66);
  assert.equal(threeMonth[0]?.close, 34);
});

test('sliceBars ALL returns the full series', () => {
  const bars = [bar('2026-01-01', 10), bar('2026-01-02', 12)];
  assert.equal(sliceBars(bars, 'ALL').length, 2);
});

test('rangeMove is first→last close percent and absolute', () => {
  const move = rangeMove([
    bar('2026-01-01', 100),
    bar('2026-01-02', 110),
    bar('2026-01-03', 125),
  ]);
  assert.ok(move);
  assert.equal(move.abs, 25);
  assert.equal(move.pct, 25);
});

test('rangeMove skips null closes at the edges', () => {
  const move = rangeMove([
    bar('2026-01-01', null),
    bar('2026-01-02', 50),
    bar('2026-01-03', 40),
    bar('2026-01-04', null),
  ]);
  assert.ok(move);
  assert.equal(move.abs, -10);
  assert.equal(move.pct, -20);
});

test('rangeMove returns null without enough closes', () => {
  assert.equal(rangeMove([]), null);
  assert.equal(rangeMove([bar('2026-01-01', 10)]), null);
  assert.equal(rangeMove([bar('2026-01-01', null), bar('2026-01-02', null)]), null);
});
