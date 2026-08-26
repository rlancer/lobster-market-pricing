/**
 * Graded questions for the text-vs-image notebook. Answers are derived from
 * the deterministic synthetic panel so scoring does not need a judge model.
 */

import { type SynthUniverse, universeStats } from './syntheticSeries.ts';

export type AnswerKind = 'ticker' | 'ticker_list' | 'date' | 'number' | 'boolean';

export interface ExperimentQuestion {
  id: string;
  prompt: string;
  kind: AnswerKind;
  expected: string;
  aliases?: string[];
  /** Absolute tolerance for kind=number. */
  tolerance?: number;
  notes: string;
}

export interface ScoreResult {
  correct: boolean;
  expected: string;
  observed: string;
  detail: string;
}

export function buildQuestions(universe: SynthUniverse): ExperimentQuestion[] {
  const stats = universeStats(universe);
  const byReturn = stats.slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const byVol = stats.slice().sort((a, b) => b.dailyReturnStdPct - a.dailyReturnStdPct);
  const best = byReturn[0]!;
  const worst = byReturn[byReturn.length - 1]!;
  const mostVol = byVol[0]!;
  const top3 = byReturn.slice(0, 3).map((s) => s.ticker);
  const crash = stats.slice().sort((a, b) => a.worstDailyReturnPct - b.worstDailyReturnPct)[0]!;

  return [
    {
      id: 'best_total_return',
      prompt: 'Which ticker had the highest total return over the full sample? Reply with the ticker only.',
      kind: 'ticker',
      expected: best.ticker,
      notes: `Ground truth total return ${best.totalReturnPct.toFixed(2)}%.`,
    },
    {
      id: 'worst_total_return',
      prompt: 'Which ticker had the lowest (most negative) total return over the full sample? Reply with the ticker only.',
      kind: 'ticker',
      expected: worst.ticker,
      notes: `Ground truth total return ${worst.totalReturnPct.toFixed(2)}%.`,
    },
    {
      id: 'most_volatile',
      prompt: 'Which ticker had the highest daily-return volatility (standard deviation)? Reply with the ticker only.',
      kind: 'ticker',
      expected: mostVol.ticker,
      notes: `Ground truth daily std ${mostVol.dailyReturnStdPct.toFixed(3)}%.`,
    },
    {
      id: 'top3',
      prompt: 'List the top 3 tickers by total return, best first. Reply as three tickers separated by commas.',
      kind: 'ticker_list',
      expected: top3.join(','),
      notes: `Expected order ${top3.join(' > ')}.`,
    },
    {
      id: 'best_peak_date',
      prompt: `On which date did ${best.ticker} reach its maximum closing price in the sample? Reply YYYY-MM-DD.`,
      kind: 'date',
      expected: best.maxCloseDate,
      notes: `Peak close ${best.maxClose.toFixed(2)} on ${best.maxCloseDate}.`,
    },
    {
      id: 'finished_above_start',
      prompt: `Did ${worst.ticker} finish the sample above its starting close? Answer YES or NO.`,
      kind: 'boolean',
      expected: worst.endClose > worst.startClose ? 'YES' : 'NO',
      aliases: worst.endClose > worst.startClose ? ['TRUE', 'Y'] : ['FALSE', 'N'],
      notes: `Start ${worst.startClose.toFixed(2)} → end ${worst.endClose.toFixed(2)}.`,
    },
    {
      id: 'crash_name',
      prompt: 'Which ticker shows the sharpest single-day crash in the sample? Reply with the ticker only.',
      kind: 'ticker',
      expected: crash.ticker,
      notes:
        `Worst one-day return ${crash.worstDailyReturnPct.toFixed(2)}% `
        + `on ${crash.worstDailyReturnDate}.`,
    },
    {
      id: 'best_return_pct',
      prompt: `What was ${best.ticker}'s total return over the sample in percent? Reply with a number only (no % sign).`,
      kind: 'number',
      expected: best.totalReturnPct.toFixed(2),
      tolerance: 1.5,
      notes: 'Allows ±1.5 percentage points for chart-reading error.',
    },
  ];
}

export function scoreAnswer(
  question: ExperimentQuestion,
  raw: string,
  allowedTickers: string[],
): ScoreResult {
  const observed = raw.trim();
  const allowed = new Set(allowedTickers.map((t) => t.toUpperCase()));

  if (question.kind === 'ticker') {
    const got = observed.toUpperCase();
    const expected = question.expected.toUpperCase();
    const correct = allowed.has(got) && got === expected;
    return {
      correct,
      expected,
      observed: got,
      detail: correct ? 'exact ticker match' : `expected ${expected}, got ${got}`,
    };
  }

  if (question.kind === 'ticker_list') {
    const expected = question.expected.split(',').map((t) => t.trim().toUpperCase());
    const got = observed.split(',').map((t) => t.trim().toUpperCase());
    const correct = got.length === expected.length
      && got.every((ticker, index) => allowed.has(ticker) && ticker === expected[index]);
    return {
      correct,
      expected: expected.join(','),
      observed: got.join(','),
      detail: correct ? 'exact ordered ticker list match' : `expected ${expected.join(',')}, got ${got.join(',')}`,
    };
  }

  if (question.kind === 'date') {
    const got = observed;
    const correct = got === question.expected;
    return {
      correct,
      expected: question.expected,
      observed: got,
      detail: correct ? 'date match' : `expected ${question.expected}, got ${got}`,
    };
  }

  if (question.kind === 'boolean') {
    const upper = observed.toUpperCase();
    const got = upper;
    const aliases = new Set([
      question.expected.toUpperCase(),
      ...(question.aliases ?? []).map((a) => a.toUpperCase()),
    ]);
    const correct = aliases.has(got);
    return {
      correct,
      expected: question.expected,
      observed: got,
      detail: correct ? 'boolean match' : `expected ${question.expected}, got ${got}`,
    };
  }

  const got = /^-?\d+(?:\.\d+)?$/.test(observed) ? Number(observed) : NaN;
  const expected = Number(question.expected);
  const tol = question.tolerance ?? 0.5;
  const correct = Number.isFinite(got) && Math.abs(got - expected) <= tol;
  return {
    correct,
    expected: question.expected,
    observed: Number.isFinite(got) ? String(got) : observed,
    detail: correct ? `within ±${tol}` : `expected ${expected}±${tol}, got ${got}`,
  };
}

export const SYSTEM_PROBE = [
  'You are grading a market-data reading test.',
  'Use ONLY the provided context (text table/summary, chart image, and/or markdown color key).',
  'When a color key is provided, the chart image has no text labels — map colors to tickers via the key.',
  'Do not use outside knowledge of real tickers or prices — these series are synthetic.',
  'Follow the answer format in the question exactly. Be concise.',
].join(' ');
