/**
 * Hybrid (multimodal) encodings: textless chart PNG + markdown color legend.
 * Hypothesis: models read graphics better when ticker identity lives in text
 * (no OCR of labels baked into the image).
 */

import { PANEL_PALETTE } from './palette.ts';
import {
  renderOverlayTextless,
  renderRankedBarsTextless,
  type ImageRep,
} from './imageRepresentations.ts';
import { type SynthUniverse } from './syntheticSeries.ts';

export type HybridRepId = 'overlay_color_keyed' | 'ranked_bars_color_keyed';

export interface HybridRep {
  id: HybridRepId;
  label: string;
  description: string;
  width: number;
  height: number;
  dataUrl: string;
  /** Markdown color → ticker key sent alongside the image. */
  textContext: string;
  approxTokens: number;
}

/** Markdown legend: color name + hex → ticker (and optional metric). */
export function colorLegendMarkdown(
  universe: SynthUniverse,
  extras?: { includeReturnPct?: boolean },
): string {
  const lines = [
    '# Color key',
    '',
    'The chart image has **no text labels**. Identify each series only via this key.',
    '',
    '| Color | Hex | Ticker |',
    '|-------|-----|--------|',
  ];
  universe.series.forEach((s, i) => {
    const swatch = PANEL_PALETTE[i % PANEL_PALETTE.length]!;
    lines.push(`| ${swatch.name} | \`${swatch.hex}\` | ${s.ticker} |`);
  });
  if (extras?.includeReturnPct) {
    lines.push('');
    lines.push('Each bar uses that ticker\'s color from the table above.');
    lines.push('Bars to the right of the center line are positive total return; left are negative.');
    lines.push('Bar length encodes |total return|. Rows are sorted best → worst top to bottom.');
  } else {
    lines.push('');
    lines.push('Lines are normalized performance (start = 100). Higher ending line = higher total return.');
  }
  return lines.join('\n');
}

function wrapHybrid(
  id: HybridRepId,
  label: string,
  description: string,
  image: ImageRep,
  textContext: string,
): HybridRep {
  return {
    id,
    label,
    description,
    width: image.width,
    height: image.height,
    dataUrl: image.dataUrl,
    textContext,
    approxTokens: Math.ceil(textContext.length / 4),
  };
}

export function buildHybridRepresentations(universe: SynthUniverse): HybridRep[] {
  const overlayLegend = colorLegendMarkdown(universe);
  const barsLegend = colorLegendMarkdown(universe, { includeReturnPct: true });
  return [
    wrapHybrid(
      'overlay_color_keyed',
      'Overlay + color key (no OCR)',
      'Textless normalized overlay; ticker identity only in the markdown color key.',
      renderOverlayTextless(universe),
      overlayLegend,
    ),
    wrapHybrid(
      'ranked_bars_color_keyed',
      'Ranked bars + color key (no OCR)',
      'Textless sorted return bars; tickers and polarity cues live in markdown, not pixels.',
      renderRankedBarsTextless(universe),
      barsLegend,
    ),
  ];
}

/** True when a saved run stores the same id in both text_reps and images. */
export function isHybridRepId(id: string): boolean {
  return id === 'overlay_color_keyed' || id === 'ranked_bars_color_keyed';
}
