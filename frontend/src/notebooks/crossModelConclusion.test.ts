import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCrossModelConclusion,
  pickLatestRunPerModel,
  repFamily,
} from './crossModelConclusion.ts';

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

describe('buildCrossModelConclusion', () => {
  it('names the winning representation and family', () => {
    const conclusion = buildCrossModelConclusion([
      {
        id: 'a',
        model: 'openai/gpt-4o-mini',
        created_at: 1,
        cells_correct: 5,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['tool_summary', 'overlay_normalized'],
        rep_accuracy: [
          { rep_id: 'tool_summary', correct: 4, done: 4 },
          { rep_id: 'overlay_normalized', correct: 1, done: 4 },
        ],
      },
      {
        id: 'b',
        model: 'google/gemini-3.7-flash',
        created_at: 2,
        cells_correct: 6,
        cells_done: 8,
        cells_total: 8,
        rep_order: ['tool_summary', 'overlay_normalized'],
        rep_accuracy: [
          { rep_id: 'tool_summary', correct: 4, done: 4 },
          { rep_id: 'overlay_normalized', correct: 2, done: 4 },
        ],
      },
    ]);
    assert.equal(conclusion.winningRep?.repId, 'tool_summary');
    assert.equal(conclusion.winningFamily?.family, 'text');
    assert.match(conclusion.summary, /winning method family is text packs/i);
    assert.match(conclusion.wrapUp, /production question/i);
    assert.match(conclusion.wrapUp, /text packs clearly outperform/i);
    assert.equal(repFamily('ranked_bars_color_keyed'), 'hybrid');
  });
});
