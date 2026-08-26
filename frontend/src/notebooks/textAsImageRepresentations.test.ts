/**
 * Browser harness smoke for text→image rasters (needs canvas).
 * Run via: node --test with playwright is heavy; keep a pure mapping test here
 * and exercise canvas in the CI experiment harness.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTextRepresentations } from './textRepresentations.ts';
import { buildSynthUniverse } from './syntheticSeries.ts';
import { isTextAsImageRepId } from './textAsImageRepresentations.ts';

test('text packs map 1:1 onto *_as_image ids', () => {
  const reps = buildTextRepresentations(buildSynthUniverse());
  assert.equal(reps.length, 3);
  for (const r of reps) {
    assert.equal(isTextAsImageRepId(`${r.id}_as_image`), true);
  }
  assert.equal(isTextAsImageRepId('overlay_normalized'), false);
  assert.equal(isTextAsImageRepId('tool_summary'), false);
});
