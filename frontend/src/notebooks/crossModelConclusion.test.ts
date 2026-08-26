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
        id: 'partial',
        model: 'openai/gpt-4o-mini',
        created_at: 10,
        cells_correct: 1,
        cells_done: 1,
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

  it('does not pool different designs or seeds', () => {
    const base = {
      cells_correct: 8,
      cells_done: 8,
      cells_total: 8,
      rep_accuracy: [],
    };
    const picked = pickLatestRunPerModel([
      {
        ...base,
        id: 'current',
        model: 'openai/gpt',
        seed: 42,
        design_id: 'v2',
        manifest_fingerprint: 'fingerprint-a',
        created_at: 10,
      },
      {
        ...base,
        id: 'wrong-design',
        model: 'google/gemini',
        seed: 42,
        design_id: 'v1',
        manifest_fingerprint: 'fingerprint-a',
        created_at: 9,
      },
      {
        ...base,
        id: 'wrong-seed',
        model: 'anthropic/claude',
        seed: 7,
        design_id: 'v2',
        manifest_fingerprint: 'fingerprint-a',
        created_at: 8,
      },
      {
        ...base,
        id: 'wrong-manifest',
        model: 'x-ai/grok',
        seed: 42,
        design_id: 'v2',
        manifest_fingerprint: 'fingerprint-b',
        created_at: 7,
      },
    ]);
    assert.deepEqual(picked.map((run) => run.id), ['current']);
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
    assert.match(conclusion.summary, /highest observed method-family mean is text packs/i);
    assert.match(conclusion.summary, /no significance claim/i);
    assert.match(conclusion.wrapUp, /descriptive benchmark evidence/i);
    assert.match(conclusion.wrapUp, /not .*production recommendation/i);
    assert.equal(repFamily('ranked_bars_color_keyed'), 'hybrid');
  });
});
