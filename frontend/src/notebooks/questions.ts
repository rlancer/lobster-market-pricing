/**
 * Graded questions for the text-vs-image notebook. Answers are derived from
 * the deterministic synthetic panel so scoring does not need a judge model.
 *
 * Includes basic ranking prompts plus density-stress items that require
 * scanning many rows/cells (counts, medians, sector aggregates, lookups).
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
  const secondVol = byVol[1]!;
  const top3 = byReturn.slice(0, 3).map((s) => s.ticker);
  const top5 = byReturn.slice(0, 5).map((s) => s.ticker);
  const bottom3 = byReturn.slice(-3).map((s) => s.ticker);
  const crash = stats.slice().sort((a, b) => a.worstDailyReturnPct - b.worstDailyReturnPct)[0]!;

  const positiveCount = stats.filter((s) => s.totalReturnPct > 0).length;
  const medianIdx = Math.floor(byReturn.length / 2);
  const median = byReturn[medianIdx]!;

  const sectorMeans = new Map<string, { sum: number; n: number }>();
  for (const s of stats) {
    const cur = sectorMeans.get(s.sector) ?? { sum: 0, n: 0 };
    cur.sum += s.totalReturnPct;
    cur.n += 1;
    sectorMeans.set(s.sector, cur);
  }
  let bestSector = '';
  let bestSectorMean = -Infinity;
  for (const [sector, { sum, n }] of sectorMeans) {
    const mean = sum / n;
    if (mean > bestSectorMean) {
      bestSectorMean = mean;
      bestSector = sector;
    }
  }

  // Mid-panel lookup: forces reading a non-extreme row in dense tables/CSVs.
  const probeRank = Math.min(byReturn.length - 1, Math.max(10, Math.floor(byReturn.length * 0.4)));
  const probe = byReturn[probeRank]!;
  const probeSeries = universe.series.find((s) => s.ticker === probe.ticker)!;
  const probeBar = probeSeries.bars[Math.floor(probeSeries.bars.length / 2)]!;

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
      id: 'second_most_volatile',
      prompt: 'Which ticker had the second-highest daily-return volatility? Reply with the ticker only.',
      kind: 'ticker',
      expected: secondVol.ticker,
      notes: `Ground truth daily std ${secondVol.dailyReturnStdPct.toFixed(3)}%.`,
    },
    {
      id: 'top3',
      prompt: 'List the top 3 tickers by total return, best first. Reply as three tickers separated by commas.',
      kind: 'ticker_list',
      expected: top3.join(','),
      notes: `Expected order ${top3.join(' > ')}.`,
    },
    {
      id: 'top5',
      prompt: 'List the top 5 tickers by total return, best first. Reply as five tickers separated by commas.',
      kind: 'ticker_list',
      expected: top5.join(','),
      notes: `Expected order ${top5.join(' > ')}.`,
    },
    {
      id: 'bottom3',
      prompt: 'List the 3 worst tickers by total return, worst first. Reply as three tickers separated by commas.',
      kind: 'ticker_list',
      expected: bottom3.slice().reverse().join(','),
      notes: `Worst-first ${bottom3.slice().reverse().join(' > ')}.`,
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
    {
      id: 'positive_count',
      prompt: 'How many tickers finished the sample with a positive total return? Reply with an integer only.',
      kind: 'number',
      expected: String(positiveCount),
      tolerance: 0,
      notes: `Count of total_return_pct > 0 among ${stats.length} names.`,
    },
    {
      id: 'median_return_ticker',
      prompt:
        `Among all ${stats.length} tickers sorted by total return (best first), which ticker sits at 0-based index ${medianIdx} (the median rank)? Reply with the ticker only.`,
      kind: 'ticker',
      expected: median.ticker,
      notes: `Median rank return ${median.totalReturnPct.toFixed(2)}%.`,
    },
    {
      id: 'best_sector_mean',
      prompt:
        'Which sector has the highest mean total return across its tickers? Reply with the sector name only (exact spelling from the data).',
      kind: 'ticker',
      expected: bestSector,
      notes: `Mean ${bestSectorMean.toFixed(2)}% — scored via exact string match on sector label.`,
    },
    {
      id: 'mid_rank_return_pct',
      prompt:
        `What was ${probe.ticker}'s total return over the sample in percent? Reply with a number only (no % sign).`,
      kind: 'number',
      expected: probe.totalReturnPct.toFixed(2),
      tolerance: 2,
      notes: `Non-extreme rank ${probeRank}; ±2pp tolerance.`,
    },
    {
      id: 'mid_panel_close',
      prompt:
        `What was ${probe.ticker}'s closing price on ${probeBar.date}? Reply with a number only.`,
      kind: 'number',
      expected: probeBar.close.toFixed(2),
      tolerance: 0.5,
      notes: 'Exact mid-sample close lookup — stresses dense CSV / tool samples.',
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
    // Sector names and other non-ticker labels: exact match without the ticker allowlist.
    if (!allowed.has(expected)) {
      const correct = got === expected;
      return {
        correct,
        expected,
        observed: got,
        detail: correct ? 'exact label match' : `expected ${expected}, got ${got}`,
      };
    }
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
  'Use ONLY the provided context (text table/summary, chart image, rasterized text image, and/or markdown color key).',
  'When a color key is provided, the chart image has no text labels — map colors to tickers via the key.',
  'When the context is a rasterized text screenshot, read the monospace text in the image (same content as a text pack).',
  'Do not use outside knowledge of real tickers or prices — these series are synthetic.',
  'Follow the answer format in the question exactly. Be concise.',
].join(' ');
