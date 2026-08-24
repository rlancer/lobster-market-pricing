/**
 * Unit tests for markdown color legends (no canvas / DOM required).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { colorLegendMarkdown, isHybridRepId } from './hybridRepresentations.ts';
import { buildSynthUniverse } from './syntheticSeries.ts';
import { PANEL_PALETTE } from './palette.ts';

describe('colorLegendMarkdown', () => {
  it('maps every ticker to a named hex swatch', () => {
    const universe = buildSynthUniverse();
    const md = colorLegendMarkdown(universe);
    assert.match(md, /# Color key/);
    assert.match(md, /no text labels/i);
    for (const series of universe.series) {
      assert.match(md, new RegExp(`\\| ${series.ticker} \\|`));
    }
    assert.ok(md.includes(PANEL_PALETTE[0]!.hex));
    assert.ok(md.includes(PANEL_PALETTE[0]!.name));
  });

  it('adds ranked-bar reading notes when requested', () => {
    const universe = buildSynthUniverse();
    const md = colorLegendMarkdown(universe, { includeReturnPct: true });
    assert.match(md, /center line/i);
    assert.match(md, /best → worst/i);
  });
});

describe('isHybridRepId', () => {
  it('recognizes color-keyed hybrid ids', () => {
    assert.equal(isHybridRepId('overlay_color_keyed'), true);
    assert.equal(isHybridRepId('ranked_bars_color_keyed'), true);
    assert.equal(isHybridRepId('overlay_normalized'), false);
  });
});
