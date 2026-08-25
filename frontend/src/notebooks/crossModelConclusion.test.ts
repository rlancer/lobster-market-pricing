import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accuracyFromCells,
  buildCrossModelConclusion,
  pickLatestRunPerModel,
  pickLatestRunPerModelSeed,
  repFamily,
  usesChartFairScoring,
} from './crossModelConclusion.ts';

describe('repFamily', () => {
  it('splits precomputed text from raw CSV', () => {
    assert.equal(repFamily('tool_summary'), 'precomputed_text');
    assert.equal(repFamily('stats_table'), 'precomputed_text');
    assert.equal(repFamily('csv_closes'), 'raw_text');
    assert.equal(repFamily('ranked_bars'), 'labeled_image');
    assert.equal(repFamily('ranked_bars_color_keyed'), 'hybrid');
  });
});

describe('pickLatestRunPerModel', () => {
  it('keeps the newest run per model', () => {
    const picked = pickLatestRunPerModel([
      {
        id: 'old',
        model: 'openai/gpt-4o-mini',
        created_at: 1,
        cells_correct: 10,
        cells_done: 56,
        cells_total: 56,
        rep_accuracy: [],
      },
      {
        id: 'new',
        model: 'openai/gpt-4o-mini',
        created_at: 9,
        cells_correct: 26,
        cells_done: 56,
        cells_total: 56,
        rep_accuracy: [],
      },
      {
        id: 'g',
        model: 'google/gemini-3.7-flash',
        created_at: 5,
        cells_correct: 45,
        cells_done: 72,
        cells_total: 72,
        rep_accuracy: [],
      },
    ]);
    assert.equal(picked.length, 2);
    assert.equal(picked.find((r) => r.model.includes('gpt-4o'))?.id, 'new');
  });
});

describe('pickLatestRunPerModelSeed', () => {
  it('keeps one run per model×seed', () => {
    const picked = pickLatestRunPerModelSeed([
      {
        id: 'a1',
        model: 'google/gemini-3.7-flash',
        seed: 1,
        created_at: 1,
        cells_correct: 40,
        cells_done: 72,
        cells_total: 72,
        rep_accuracy: [],
      },
      {
        id: 'a2',
        model: 'google/gemini-3.7-flash',
        seed: 2,
        created_at: 2,
        cells_correct: 42,
        cells_done: 72,
        cells_total: 72,
        rep_accuracy: [],
      },
      {
        id: 'a1b',
        model: 'google/gemini-3.7-flash',
        seed: 1,
        created_at: 9,
        cells_correct: 44,
        cells_done: 72,
        cells_total: 72,
        rep_accuracy: [],
      },
    ]);
    assert.equal(picked.length, 2);
    assert.equal(picked.find((r) => r.seed === 1)?.id, 'a1b');
    assert.equal(picked.find((r) => r.seed === 2)?.id, 'a2');
  });
});

describe('accuracyFromCells', () => {
  it('excludes chart-hostile questions when chartFair', () => {
    const cells = [
      { rep_id: 'ranked_bars', question_id: 'best_total_return', status: 'done', correct: true },
      { rep_id: 'ranked_bars', question_id: 'best_peak_date', status: 'done', correct: false },
      { rep_id: 'stats_table', question_id: 'best_peak_date', status: 'done', correct: true },
    ];
    const all = accuracyFromCells(cells);
    const fair = accuracyFromCells(cells, { chartFair: true });
    assert.equal(all.find((r) => r.rep_id === 'ranked_bars')?.done, 2);
    assert.equal(fair.find((r) => r.rep_id === 'ranked_bars')?.done, 1);
    assert.equal(fair.find((r) => r.rep_id === 'ranked_bars')?.correct, 1);
  });
});

describe('buildCrossModelConclusion', () => {
  it('names the winning representation and precomputed-text family', () => {
    const conclusion = buildCrossModelConclusion([
      {
        id: 'a',
        model: 'openai/gpt-4o-mini',
        seed: 1,
        created_at: 1,
        cells_correct: 5,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['tool_summary', 'csv_closes', 'overlay_normalized'],
        rep_accuracy: [
          { rep_id: 'tool_summary', correct: 4, done: 4 },
          { rep_id: 'csv_closes', correct: 2, done: 4 },
          { rep_id: 'overlay_normalized', correct: 1, done: 4 },
        ],
      },
      {
        id: 'b',
        model: 'google/gemini-3.7-flash',
        seed: 1,
        created_at: 2,
        cells_correct: 6,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['tool_summary', 'csv_closes', 'overlay_normalized'],
        rep_accuracy: [
          { rep_id: 'tool_summary', correct: 4, done: 4 },
          { rep_id: 'csv_closes', correct: 2, done: 4 },
          { rep_id: 'overlay_normalized', correct: 2, done: 4 },
        ],
      },
    ]);
    assert.equal(conclusion.winningRep?.repId, 'tool_summary');
    assert.equal(conclusion.winningFamily?.family, 'precomputed_text');
    assert.match(conclusion.summary, /precomputed text/i);
    assert.equal(repFamily('ranked_bars_color_keyed'), 'hybrid');
    assert.equal(usesChartFairScoring('labeled_image'), true);
  });

  it('averages multiple seeds per model and notes seed count', () => {
    const conclusion = buildCrossModelConclusion([
      {
        id: 's1',
        model: 'google/gemini-3.7-flash',
        seed: 10,
        created_at: 1,
        cells_correct: 4,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['stats_table', 'ranked_bars'],
        rep_accuracy: [
          { rep_id: 'stats_table', correct: 4, done: 4 },
          { rep_id: 'ranked_bars', correct: 0, done: 4 },
        ],
        cells: [
          { rep_id: 'ranked_bars', question_id: 'best_total_return', status: 'done', correct: false },
          { rep_id: 'ranked_bars', question_id: 'best_peak_date', status: 'done', correct: false },
          { rep_id: 'ranked_bars', question_id: 'worst_total_return', status: 'done', correct: false },
          { rep_id: 'ranked_bars', question_id: 'top3', status: 'done', correct: false },
          { rep_id: 'stats_table', question_id: 'best_total_return', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'best_peak_date', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'worst_total_return', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'top3', status: 'done', correct: true },
        ],
      },
      {
        id: 's2',
        model: 'google/gemini-3.7-flash',
        seed: 20,
        created_at: 2,
        cells_correct: 6,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['stats_table', 'ranked_bars'],
        rep_accuracy: [
          { rep_id: 'stats_table', correct: 4, done: 4 },
          { rep_id: 'ranked_bars', correct: 2, done: 4 },
        ],
        cells: [
          { rep_id: 'ranked_bars', question_id: 'best_total_return', status: 'done', correct: true },
          { rep_id: 'ranked_bars', question_id: 'best_peak_date', status: 'done', correct: false },
          { rep_id: 'ranked_bars', question_id: 'worst_total_return', status: 'done', correct: true },
          { rep_id: 'ranked_bars', question_id: 'top3', status: 'done', correct: false },
          { rep_id: 'stats_table', question_id: 'best_total_return', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'best_peak_date', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'worst_total_return', status: 'done', correct: true },
          { rep_id: 'stats_table', question_id: 'top3', status: 'done', correct: true },
        ],
      },
    ]);
    assert.equal(conclusion.models.length, 1);
    assert.equal(conclusion.models[0]!.seeds, 2);
    assert.equal(conclusion.seedCount, 2);
    assert.match(conclusion.summary, /2 panel seeds/i);
    const ranked = conclusion.rows.find((r) => r.repId === 'ranked_bars');
    assert.equal(ranked?.chartFair, true);
    // chart-fair drops best_peak_date → 0/3 + 2/3 = 2/6
    assert.equal(ranked?.byModel[0]!.correct, 2);
    assert.equal(ranked?.byModel[0]!.done, 6);
  });
});
