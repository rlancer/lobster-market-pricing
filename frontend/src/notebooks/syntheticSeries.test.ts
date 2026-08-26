import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNTH_TICKERS,
  buildSynthUniverse,
  tickerStats,
  universeStats,
} from './syntheticSeries.ts';
import { buildTextRepresentations } from './textRepresentations.ts';
import { buildQuestions, scoreAnswer } from './questions.ts';

test('synthetic universe is deterministic for a fixed seed', () => {
  const a = buildSynthUniverse(42);
  const b = buildSynthUniverse(42);
  assert.equal(a.series.length, SYNTH_TICKERS.length);
  assert.equal(a.series[0]!.bars.length, a.tradingDays);
  assert.deepEqual(
    a.series.map((s) => s.bars.map((bar) => bar.close)),
    b.series.map((s) => s.bars.map((bar) => bar.close)),
  );
});

test('different seeds produce different paths', () => {
  const a = buildSynthUniverse(1);
  const b = buildSynthUniverse(2);
  assert.notDeepEqual(
    a.series[0]!.bars.map((x) => x.close),
    b.series[0]!.bars.map((x) => x.close),
  );
});

test('stats identify a unique best and worst total return', () => {
  const stats = universeStats(buildSynthUniverse());
  const sorted = stats.slice().sort((x, y) => y.totalReturnPct - x.totalReturnPct);
  assert.notEqual(sorted[0]!.ticker, sorted[sorted.length - 1]!.ticker);
  assert.ok(sorted[0]!.totalReturnPct > sorted[sorted.length - 1]!.totalReturnPct);
});

test('sharpest-crash ground truth uses the worst one-day return', () => {
  const universe = buildSynthUniverse();
  const stats = universeStats(universe);
  const withCrash = stats.filter((s) => s.crashDay != null);
  assert.ok(withCrash.length >= 1);
  const sharpest = stats.slice().sort((a, b) => a.worstDailyReturnPct - b.worstDailyReturnPct)[0]!;
  assert.equal(sharpest.ticker, 'MIRTH');

  const question = buildQuestions(universe).find((q) => q.id === 'crash_name')!;
  assert.equal(question.expected, sharpest.ticker);
  assert.match(question.notes, new RegExp(sharpest.worstDailyReturnDate));
});

test('text representations are non-empty and tool_summary mentions every ticker', () => {
  const universe = buildSynthUniverse();
  const reps = buildTextRepresentations(universe);
  assert.equal(reps.length, 3);
  const tool = reps.find((r) => r.id === 'tool_summary')!;
  assert.match(tool.body, /Period performance \(by ticker; close=close, date=date\):/);
  assert.match(tool.body, /ticker \| start \| end \| total_return_pct/);
  for (const ticker of SYNTH_TICKERS) {
    assert.match(tool.body, new RegExp(`\\b${ticker}\\b`));
  }
  assert.ok(tool.approxTokens > 500);
});

test('questions score exact ticker and numeric answers', () => {
  const universe = buildSynthUniverse();
  const questions = buildQuestions(universe);
  const tickers = universe.series.map((s) => s.ticker);
  const best = questions.find((q) => q.id === 'best_total_return')!;
  assert.equal(scoreAnswer(best, best.expected, tickers).correct, true);
  assert.equal(scoreAnswer(best, `I think ${best.expected} won.`, tickers).correct, false);
  assert.equal(scoreAnswer(best, `${best.expected},${tickers[1]}`, tickers).correct, false);
  assert.equal(scoreAnswer(best, 'NOTREAL', tickers).correct, false);

  const pct = questions.find((q) => q.id === 'best_return_pct')!;
  const expectedNum = Number(pct.expected);
  assert.equal(scoreAnswer(pct, String(expectedNum), tickers).correct, true);
  assert.equal(scoreAnswer(pct, String(expectedNum + 1), tickers).correct, true);
  assert.equal(scoreAnswer(pct, `${expectedNum}%`, tickers).correct, false);
  assert.equal(scoreAnswer(pct, String(expectedNum + 10), tickers).correct, false);
});

test('top3 scoring requires order', () => {
  const universe = buildSynthUniverse();
  const questions = buildQuestions(universe);
  const tickers = universe.series.map((s) => s.ticker);
  const top3 = questions.find((q) => q.id === 'top3')!;
  assert.equal(scoreAnswer(top3, top3.expected, tickers).correct, true);
  const reversed = top3.expected.split(',').reverse().join(',');
  assert.equal(scoreAnswer(top3, reversed, tickers).correct, false);
  assert.equal(scoreAnswer(top3, `${top3.expected},${tickers[0]}`, tickers).correct, false);
});

test('tickerStats matches series endpoints', () => {
  const series = buildSynthUniverse().series[0]!;
  const stats = tickerStats(series);
  assert.equal(stats.startClose, series.bars[0]!.close);
  assert.equal(stats.endClose, series.bars[series.bars.length - 1]!.close);
  const dailyReturns = series.bars.slice(1).map((bar, index) =>
    (bar.close / series.bars[index]!.close - 1) * 100);
  assert.equal(stats.worstDailyReturnPct, Math.min(...dailyReturns));
});
