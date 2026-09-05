import assert from 'node:assert/strict';
import test from 'node:test';
import type { OhlcBar } from './api.ts';
import {
  asOfQuote,
  chartRangeLabel,
  etTradeDay,
  formatChartTick,
  rangeMove,
  sliceBars,
} from './tickerChartRange.ts';

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

test('sliceBars YTD keeps bars from Jan 1 of asOf year and drops later sessions', () => {
  const bars = [
    bar('2025-12-30', 90),
    bar('2025-12-31', 91),
    bar('2026-01-02', 100),
    bar('2026-03-15', 110),
    bar('2026-08-01', 120),
    bar('2026-09-01', 130),
  ];
  const ytd = sliceBars(bars, 'YTD', '2026-08-17');
  assert.deepEqual(ytd.map((b) => b.date), ['2026-01-02', '2026-03-15', '2026-08-01']);
});

test('sliceBars MTD keeps bars from the 1st of asOf month', () => {
  const bars = [
    bar('2026-07-31', 100),
    bar('2026-08-01', 101),
    bar('2026-08-15', 105),
  ];
  const mtd = sliceBars(bars, 'MTD', '2026-08-17');
  assert.deepEqual(mtd.map((b) => b.date), ['2026-08-01', '2026-08-15']);
});

test('sliceBars 1D keeps the last daily session on or before asOf', () => {
  const bars = [bar('2026-08-14', 10), bar('2026-08-15', 11), bar('2026-08-18', 12)];
  const day = sliceBars(bars, '1D', '2026-08-17');
  assert.equal(day.length, 1);
  assert.equal(day[0]?.date, '2026-08-15');
});

test('sliceBars trailing windows count back from asOf, not the series end', () => {
  const bars = Array.from({ length: 80 }, (_, i) => {
    const day = i + 1;
    const month = day <= 31 ? '01' : '03';
    const dom = day <= 31 ? day : day - 31;
    return bar(`2026-${month}-${String(dom).padStart(2, '0')}`, day);
  });
  const oneMonth = sliceBars(bars, '1M', '2026-01-31');
  assert.equal(oneMonth.length, 22);
  assert.equal(oneMonth[0]?.date, '2026-01-10');
  assert.equal(oneMonth.at(-1)?.date, '2026-01-31');
});

test('sliceBars ALL still clips to asOf', () => {
  const bars = [bar('2026-01-01', 10), bar('2026-03-15', 12), bar('2026-08-01', 14)];
  assert.deepEqual(sliceBars(bars, 'ALL', '2026-03-15').map((b) => b.date), [
    '2026-01-01',
    '2026-03-15',
  ]);
});

test('asOfQuote uses the last close on or before asOf', () => {
  const bars = [
    bar('2026-03-06', 100),
    bar('2026-03-09', 100),
    bar('2026-03-10', 100),
    bar('2026-03-11', 110),
    bar('2026-03-12', 121),
    bar('2026-03-13', 100),
    bar('2026-03-16', 200),
  ];
  const quote = asOfQuote(bars, '2026-03-15');
  assert.equal(quote.spot, 100);
  assert.equal(quote.change_1d_pct, ((100 - 121) / 121) * 100);
  assert.equal(quote.change_5d_pct, 0);
  assert.equal(quote.change_21d_pct, null);
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

test('chartRangeLabel and formatChartTick', () => {
  assert.equal(chartRangeLabel('1D'), 'Day');
  assert.equal(chartRangeLabel('ALL'), 'All');
  assert.equal(chartRangeLabel('YTD'), 'YTD');
  assert.equal(formatChartTick('2026-08-17'), '08-17');
  assert.equal(formatChartTick('2026-08-17T09:35'), '09:35');
  assert.equal(formatChartTick('2026-08-17T15:55:00'), '15:55');
});

test('etTradeDay buckets after-hours ISO timestamps onto the ET calendar', () => {
  assert.equal(etTradeDay('2026-08-28'), '2026-08-28');
  assert.equal(etTradeDay('2026-08-28T21:30:00.000Z'), '2026-08-28');
  assert.equal(etTradeDay('2026-08-29T01:30:00.000Z'), '2026-08-28');
});
