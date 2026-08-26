/**
 * Same-content controls: rasterize each text pack onto a monospace PNG and
 * probe as image-only. Isolates modality (tokens vs pixels) without changing
 * the information — the clean test for “images handle dense context better.”
 */

import type { ImageRep } from './imageRepresentations.ts';
import {
  buildTextRepresentations,
  type TextRepId,
} from './textRepresentations.ts';
import { type SynthUniverse } from './syntheticSeries.ts';

export type TextAsImageRepId =
  | 'tool_summary_as_image'
  | 'stats_table_as_image'
  | 'csv_closes_as_image';

const TEXT_TO_IMAGE_ID: Record<TextRepId, TextAsImageRepId> = {
  tool_summary: 'tool_summary_as_image',
  stats_table: 'stats_table_as_image',
  csv_closes: 'csv_closes_as_image',
};

/** Vision models commonly resize past ~2048px; stay inside that budget. */
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 2048;
const PAD = 16;
const GUTTER = 20;
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

interface LayoutPlan {
  fontSize: number;
  lineHeight: number;
  columns: number;
  colWidth: number;
  wrapped: string[];
  width: number;
  height: number;
}

function wrapLine(line: string, maxChars: number): string[] {
  if (maxChars < 8) maxChars = 8;
  if (line.length <= maxChars) return [line.length ? line : ' '];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += maxChars) {
    out.push(line.slice(i, i + maxChars));
  }
  return out;
}

function planLayout(body: string, ctx: CanvasRenderingContext2D): LayoutPlan {
  const rawLines = body.replace(/\r\n/g, '\n').split('\n');
  // Prefer larger type; fall back to more columns before shrinking further.
  for (let fontSize = 12; fontSize >= 7; fontSize--) {
    const lineHeight = Math.ceil(fontSize * 1.35);
    ctx.font = `${fontSize}px ${FONT_STACK}`;
    const charW = Math.max(ctx.measureText('M').width, fontSize * 0.55);

    for (let columns = 1; columns <= 4; columns++) {
      const usableW = MAX_WIDTH - PAD * 2 - GUTTER * (columns - 1);
      const colWidth = Math.floor(usableW / columns);
      const maxChars = Math.max(8, Math.floor(colWidth / charW));
      const wrapped = rawLines.flatMap((line) => wrapLine(line, maxChars));
      const linesPerCol = Math.floor((MAX_HEIGHT - PAD * 2) / lineHeight);
      if (linesPerCol < 1) continue;
      if (wrapped.length > linesPerCol * columns) continue;

      const usedCols = Math.min(columns, Math.ceil(wrapped.length / linesPerCol));
      const height = Math.min(
        MAX_HEIGHT,
        PAD * 2 + Math.min(wrapped.length, linesPerCol) * lineHeight + 4,
      );
      const width = Math.min(
        MAX_WIDTH,
        PAD * 2 + usedCols * colWidth + GUTTER * Math.max(0, usedCols - 1),
      );
      return {
        fontSize,
        lineHeight,
        columns: usedCols,
        colWidth,
        wrapped,
        width,
        height,
      };
    }
  }

  // Last resort: shrink into max canvas (API may downscale further).
  const fontSize = 7;
  const lineHeight = 9;
  ctx.font = `${fontSize}px ${FONT_STACK}`;
  const charW = Math.max(ctx.measureText('M').width, fontSize * 0.55);
  const columns = 4;
  const usableW = MAX_WIDTH - PAD * 2 - GUTTER * (columns - 1);
  const colWidth = Math.floor(usableW / columns);
  const maxChars = Math.max(8, Math.floor(colWidth / charW));
  const wrapped = rawLines.flatMap((line) => wrapLine(line, maxChars));
  return {
    fontSize,
    lineHeight,
    columns,
    colWidth,
    wrapped,
    width: MAX_WIDTH,
    height: MAX_HEIGHT,
  };
}

export function renderTextBodyAsImage(
  id: TextAsImageRepId,
  label: string,
  description: string,
  body: string,
): ImageRep {
  const measure = document.createElement('canvas');
  const measureCtx = measure.getContext('2d');
  if (!measureCtx) throw new Error('2d canvas unavailable');

  const plan = planLayout(body, measureCtx);
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');

  ctx.fillStyle = '#0B1520';
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.fillStyle = '#EAF7F3';
  ctx.font = `${plan.fontSize}px ${FONT_STACK}`;
  ctx.textBaseline = 'top';

  const linesPerCol = Math.floor((plan.height - PAD * 2) / plan.lineHeight);
  for (let i = 0; i < plan.wrapped.length; i++) {
    const col = Math.floor(i / linesPerCol);
    if (col >= plan.columns) break;
    const row = i % linesPerCol;
    const x = PAD + col * (plan.colWidth + GUTTER);
    const y = PAD + row * plan.lineHeight;
    ctx.fillText(plan.wrapped[i]!, x, y, plan.colWidth);
  }

  return {
    id,
    label,
    description,
    width: plan.width,
    height: plan.height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

export function isTextAsImageRepId(id: string): id is TextAsImageRepId {
  return id.endsWith('_as_image');
}

/** Byte-identical text packs, rendered as monospace PNGs for image-only probes. */
export function buildTextAsImageRepresentations(universe: SynthUniverse): ImageRep[] {
  return buildTextRepresentations(universe).map((text) => {
    const id = TEXT_TO_IMAGE_ID[text.id];
    return renderTextBodyAsImage(
      id,
      `${text.label} → image`,
      `Exact same bytes as the ${text.id} text pack, rasterized as monospace PNG `
        + `(modality control: tokens vs pixels, identical content).`,
      text.body,
    );
  });
}
