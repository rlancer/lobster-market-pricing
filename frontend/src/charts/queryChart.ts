import {
  areaY,
  barY,
  colorLegend,
  defineChart,
  dot,
  group,
  lineY,
} from '@tanstack/charts';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import type { QueryResult } from '../api.ts';
import type { ChartKind, ChartSpec } from '../chartSpec.ts';
import { lobsterChartTheme, monotoneX, mutedAxis, fmtPlotTick } from './theme.ts';

export interface QueryPlotRow {
  x: string | number;
  y: number;
  series: string;
}

export interface QueryPlotData {
  rows: QueryPlotRow[];
  seriesNames: string[];
  numericX: boolean;
}

export function asPlotNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Long-form rows for TanStack `z` grouping (one series per distinct series value). */
export function buildQueryPlotRows(result: QueryResult, spec: ChartSpec): QueryPlotData {
  const src = result.rows;
  const numericX = src.length > 0 && src.every((row) => asPlotNumber(row[spec.x]) != null);
  const sorted = [...src].sort((a, b) => {
    if (numericX) return (asPlotNumber(a[spec.x]) ?? 0) - (asPlotNumber(b[spec.x]) ?? 0);
    return String(a[spec.x]).localeCompare(String(b[spec.x]));
  });

  const byKey = new Map<string, QueryPlotRow>();
  const order: string[] = [];
  const seriesNames: string[] = [];
  const seenSeries = new Set<string>();
  for (const row of sorted) {
    const y = asPlotNumber(row[spec.y]);
    if (y == null) continue;
    const x = numericX ? (asPlotNumber(row[spec.x]) ?? 0) : String(row[spec.x] ?? '');
    const series = spec.series ? String(row[spec.series]) : spec.y;
    if (!seenSeries.has(series)) {
      seenSeries.add(series);
      seriesNames.push(series);
    }
    const id = `${series}\0${numericX ? String(x) : x}`;
    if (!byKey.has(id)) order.push(id);
    byKey.set(id, { x, y, series });
  }
  return {
    rows: order.map((id) => byKey.get(id)!),
    seriesNames,
    numericX,
  };
}

export function defineQueryChart(input: {
  rows: QueryPlotRow[];
  kind: ChartKind;
  numericX: boolean;
  seriesNames: string[];
  xLabel?: string;
  yLabel?: string;
}) {
  const multi = input.seriesNames.length > 1;
  const xChannel = 'x' as const;
  const yChannel = 'y' as const;
  const marks = (() => {
    if (input.kind === 'bar') {
      return [
        barY(input.rows, {
          x: xChannel,
          y: yChannel,
          y1: 0,
          z: 'series',
          key: (row) => `${row.series}:${row.x}`,
          radius: 2,
          maxThickness: 28,
          ...(multi ? { layout: group({ padding: 0.12 }) } : {}),
        }),
      ];
    }
    if (input.kind === 'scatter') {
      return [
        dot(input.rows, {
          x: xChannel,
          y: yChannel,
          z: 'series',
          key: (row) => `${row.series}:${row.x}`,
          r: 4,
          fillOpacity: 0.7,
        }),
      ];
    }
    if (input.kind === 'area') {
      return [
        areaY(input.rows, {
          x: xChannel,
          y: yChannel,
          y1: 0,
          z: 'series',
          fillOpacity: 0.15,
          curve: monotoneX,
        }),
        lineY(input.rows, {
          x: xChannel,
          y: yChannel,
          z: 'series',
          key: (row) => `${row.series}:${row.x}`,
          strokeWidth: 2,
          curve: monotoneX,
        }),
      ];
    }
    return [
      lineY(input.rows, {
        x: xChannel,
        y: yChannel,
        z: 'series',
        key: (row) => `${row.series}:${row.x}`,
        strokeWidth: 2,
        curve: monotoneX,
      }),
    ];
  })();

  const categoryScale = input.kind === 'bar'
    ? () => scaleBand<string>().padding(0.18)
    : () => scalePoint<string>().padding(0.12);

  return defineChart({
    marks,
    scales: {
      x: input.numericX
        ? {
            scale: scaleLinear,
            nice: true,
            axis: mutedAxis(fmtPlotTick, { label: input.xLabel, minGap: 36 }),
          }
        : {
            scale: categoryScale,
            axis: mutedAxis((value) => fmtPlotTick(value), { label: input.xLabel, minGap: 36 }),
          },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: mutedAxis(fmtPlotTick, { label: input.yLabel }),
      },
    },
    theme: lobsterChartTheme,
    ...(multi ? { color: { legend: colorLegend({ placement: 'bottom' }) } } : {}),
    svgAnimation: false,
    focus: input.kind === 'scatter' ? undefined : 'nearest-x',
    tooltip: {
      use: tooltip,
      className: 'lobster-chart-tooltip',
    },
  });
}
