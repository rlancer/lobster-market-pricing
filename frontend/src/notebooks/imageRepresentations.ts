/**
 * Canvas PNG encodings of the synthetic panel for multimodal probes.
 * Browser-only (uses document.createElement('canvas')).
 */

import { paletteHex } from './palette.ts';
import { type SynthUniverse, universeStats } from './syntheticSeries.ts';

export type ImageRepId =
  | 'overlay_normalized'
  | 'small_multiples'
  | 'returns_heatmap'
  | 'ranked_bars'
  | 'overlay_textless'
  | 'ranked_bars_textless'
  | 'tool_summary_as_image'
  | 'stats_table_as_image'
  | 'csv_closes_as_image';

export interface ImageRep {
  id: ImageRepId;
  label: string;
  description: string;
  width: number;
  height: number;
  dataUrl: string;
}

function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  return { canvas, ctx };
}

function paintBg(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#0B1520';
  ctx.fillRect(0, 0, w, h);
}

function title(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.fillStyle = '#EAF7F3';
  ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(text, x, y);
}

function legend(
  ctx: CanvasRenderingContext2D,
  labels: string[],
  x: number,
  y: number,
  columns = 5,
): void {
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  labels.forEach((label, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const lx = x + col * 90;
    const ly = y + row * 16;
    ctx.fillStyle = paletteHex(i);
    ctx.fillRect(lx, ly - 8, 10, 10);
    ctx.fillStyle = '#C8D7D3';
    ctx.fillText(label, lx + 14, ly);
  });
}

export function renderOverlayNormalized(universe: SynthUniverse): ImageRep {
  const n = universe.series.length;
  const width = 1100;
  const legendRows = Math.ceil(n / 10);
  const height = 640 + Math.max(0, legendRows - 4) * 16;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);
  title(ctx, `Normalized performance (start = 100, n=${n})`, 24, 28);

  const pad = { top: 56, right: 24, bottom: 32 + legendRows * 16, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const rebased = universe.series.map((s) => {
    const base = s.bars[0]!.close;
    return s.bars.map((b) => (b.close / base) * 100);
  });
  let minV = Infinity;
  let maxV = -Infinity;
  for (const series of rebased) {
    for (const v of series) {
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const span = Math.max(maxV - minV, 1);

  ctx.strokeStyle = '#1E2F3C';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    const val = maxV - (span * g) / 4;
    ctx.fillStyle = '#8EA8AA';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(val.toFixed(0), 12, y + 3);
  }

  rebased.forEach((series, idx) => {
    ctx.strokeStyle = paletteHex(idx);
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = pad.left + (i / Math.max(series.length - 1, 1)) * plotW;
      const y = pad.top + ((maxV - v) / span) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  legend(ctx, universe.series.map((s) => s.ticker), pad.left, height - pad.bottom + 12, 10);

  return {
    id: 'overlay_normalized',
    label: 'Overlay (normalized)',
    description:
      `All ${universe.series.length} names rebased to 100. Strong for relative ranking; weak for absolute levels.`,
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

/**
 * Same geometry as overlay_normalized but zero glyphs — no title, axes, or
 * ticker legend. Identity must come from a companion markdown color key.
 */
export function renderOverlayTextless(universe: SynthUniverse): ImageRep {
  const width = 1100;
  const height = 560;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);

  const pad = { top: 24, right: 24, bottom: 24, left: 24 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const rebased = universe.series.map((s) => {
    const base = s.bars[0]!.close;
    return s.bars.map((b) => (b.close / base) * 100);
  });
  let minV = Infinity;
  let maxV = -Infinity;
  for (const series of rebased) {
    for (const v of series) {
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const span = Math.max(maxV - minV, 1);

  ctx.strokeStyle = '#1E2F3C';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.top + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
  }

  rebased.forEach((series, idx) => {
    ctx.strokeStyle = paletteHex(idx);
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = pad.left + (i / Math.max(series.length - 1, 1)) * plotW;
      const y = pad.top + ((maxV - v) / span) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  return {
    id: 'overlay_textless',
    label: 'Overlay (textless)',
    description: 'Normalized overlay with no labels — pair with a markdown color key.',
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

export function renderSmallMultiples(universe: SynthUniverse): ImageRep {
  const n = universe.series.length;
  const cols = Math.max(5, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const cellW = n > 40 ? 160 : 210;
  const cellH = n > 40 ? 110 : 140;
  const width = cols * cellW + 24;
  const height = rows * cellH + 48;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);
  title(ctx, `Small multiples — close with period return (${n})`, 24, 28);
  const stats = universeStats(universe);

  universe.series.forEach((series, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x0 = 12 + col * cellW;
    const y0 = 40 + row * cellH;
    const s = stats[idx]!;
    ctx.fillStyle = '#102432';
    ctx.fillRect(x0, y0, cellW - 10, cellH - 10);
    ctx.fillStyle = '#EAF7F3';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(series.ticker, x0 + 8, y0 + 14);
    ctx.fillStyle = s.totalReturnPct >= 0 ? '#49D89D' : '#FF806F';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(
      `${s.totalReturnPct >= 0 ? '+' : ''}${s.totalReturnPct.toFixed(1)}%`,
      x0 + Math.min(70, cellW - 54),
      y0 + 14,
    );

    const closes = series.bars.map((b) => b.close);
    const minV = Math.min(...closes);
    const maxV = Math.max(...closes);
    const span = Math.max(maxV - minV, 1e-6);
    const plotW = cellW - 26;
    const plotH = cellH - 42;
    ctx.strokeStyle = paletteHex(idx);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    closes.forEach((v, i) => {
      const x = x0 + 8 + (i / Math.max(closes.length - 1, 1)) * plotW;
      const y = y0 + 24 + ((maxV - v) / span) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  return {
    id: 'small_multiples',
    label: 'Small multiples',
    description: 'Per-ticker sparkline with labeled period return — preserves identity better than a crowded overlay.',
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

export function renderReturnsHeatmap(universe: SynthUniverse): ImageRep {
  const months: string[] = [];
  for (const bar of universe.series[0]!.bars) {
    const key = bar.date.slice(0, 7);
    if (!months.includes(key)) months.push(key);
  }

  const cellH = universe.series.length > 40 ? 16 : 22;
  const width = Math.max(980, 72 + months.length * 48 + 24);
  const height = 40 + universe.series.length * cellH + 60;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);
  title(ctx, 'Monthly return heatmap (%)', 24, 28);

  const left = 72;
  const top = 48;
  const cellW = (width - left - 24) / months.length;

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#8EA8AA';
  months.forEach((m, i) => {
    ctx.fillText(m.slice(5), left + i * cellW + 8, top - 8);
  });

  universe.series.forEach((series, row) => {
    const y = top + row * cellH;
    ctx.fillStyle = '#C8D7D3';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(series.ticker, 16, y + Math.min(13, cellH - 2));

    months.forEach((month, col) => {
      const monthBars = series.bars.filter((b) => b.date.startsWith(month));
      if (monthBars.length < 2) return;
      const ret = monthBars[monthBars.length - 1]!.close / monthBars[0]!.close - 1;
      const intensity = Math.min(Math.abs(ret) / 0.2, 1);
      ctx.fillStyle = ret >= 0
        ? `rgba(73, 216, 157, ${0.15 + intensity * 0.85})`
        : `rgba(255, 128, 111, ${0.15 + intensity * 0.85})`;
      ctx.fillRect(left + col * cellW, y, cellW - 2, cellH - 2);
      if (cellH >= 18) {
        ctx.fillStyle = '#0B1520';
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(`${(ret * 100).toFixed(0)}`, left + col * cellW + 6, y + 12);
      }
    });
  });

  return {
    id: 'returns_heatmap',
    label: 'Returns heatmap',
    description: 'Monthly % returns by ticker. Tests whether models can read tabular color encodings.',
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

export function renderRankedBars(universe: SynthUniverse): ImageRep {
  const stats = universeStats(universe).slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const rowH = stats.length > 40 ? 18 : 26;
  const width = 900;
  const height = 48 + stats.length * rowH + 24;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);
  title(ctx, 'Total return ranking', 24, 28);

  const maxAbs = Math.max(...stats.map((s) => Math.abs(s.totalReturnPct)), 1);
  const left = 90;
  const barMax = width - left - 80;
  const mid = left + barMax / 2;

  stats.forEach((s, i) => {
    const y = 48 + i * rowH;
    ctx.fillStyle = '#C8D7D3';
    ctx.font = `${rowH >= 26 ? 12 : 10}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(s.ticker, 16, y + Math.min(14, rowH - 2));
    const w = (Math.abs(s.totalReturnPct) / maxAbs) * (barMax / 2);
    ctx.fillStyle = s.totalReturnPct >= 0 ? '#49D89D' : '#FF806F';
    const barY = y + Math.max(2, Math.floor((rowH - 12) / 2));
    if (s.totalReturnPct >= 0) ctx.fillRect(mid, barY, w, Math.min(14, rowH - 4));
    else ctx.fillRect(mid - w, barY, w, Math.min(14, rowH - 4));
    ctx.fillStyle = '#EAF7F3';
    ctx.font = '10px ui-monospace, monospace';
    const label = `${s.totalReturnPct >= 0 ? '+' : ''}${s.totalReturnPct.toFixed(1)}%`;
    ctx.fillText(label, mid + (s.totalReturnPct >= 0 ? w + 6 : -w - 48), y + Math.min(14, rowH - 2));
  });

  ctx.strokeStyle = '#1E2F3C';
  ctx.beginPath();
  ctx.moveTo(mid, 44);
  ctx.lineTo(mid, height - 16);
  ctx.stroke();

  return {
    id: 'ranked_bars',
    label: 'Ranked return bars',
    description: 'Sorted total-return bars — strongest for who-won questions, weak for path dependence.',
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

/**
 * Sorted return bars with no ticker or percent glyphs — only colored bar
 * geometry. Pair with markdown color key for identity.
 */
export function renderRankedBarsTextless(universe: SynthUniverse): ImageRep {
  const stats = universeStats(universe).slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const rowH = stats.length > 40 ? 18 : 26;
  const width = 900;
  const height = 24 + stats.length * rowH + 24;
  const { canvas, ctx } = makeCanvas(width, height);
  paintBg(ctx, width, height);

  const maxAbs = Math.max(...stats.map((s) => Math.abs(s.totalReturnPct)), 1);
  const left = 40;
  const barMax = width - left - 40;
  const mid = left + barMax / 2;

  stats.forEach((s, i) => {
    const y = 24 + i * rowH;
    const w = (Math.abs(s.totalReturnPct) / maxAbs) * (barMax / 2);
    const seriesIdx = universe.series.findIndex((ser) => ser.ticker === s.ticker);
    ctx.fillStyle = seriesIdx >= 0
      ? paletteHex(seriesIdx)
      : (s.totalReturnPct >= 0 ? '#49D89D' : '#FF806F');
    const barY = y + Math.max(2, Math.floor((rowH - 12) / 2));
    if (s.totalReturnPct >= 0) ctx.fillRect(mid, barY, w, Math.min(14, rowH - 4));
    else ctx.fillRect(mid - w, barY, w, Math.min(14, rowH - 4));
  });

  ctx.strokeStyle = '#1E2F3C';
  ctx.beginPath();
  ctx.moveTo(mid, 20);
  ctx.lineTo(mid, height - 12);
  ctx.stroke();

  return {
    id: 'ranked_bars_textless',
    label: 'Ranked bars (textless)',
    description: 'Sorted return bars with no labels — pair with a markdown color key.',
    width,
    height,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

/** Classic labeled chart encodings (probed as image-only). */
export function buildImageRepresentations(universe: SynthUniverse): ImageRep[] {
  return [
    renderOverlayNormalized(universe),
    renderSmallMultiples(universe),
    renderReturnsHeatmap(universe),
    renderRankedBars(universe),
  ];
}
