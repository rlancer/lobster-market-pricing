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
import {
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  companionBarMeasures,
  humanizeColumn,
  isWideMeasure,
  normalizeChartSpec,
  siblingMeasureColumns,
  type ChartKind,
  type ChartSpec,
} from '../chartSpec.ts';
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
  kind: ChartKind;
  xLabel?: string;
  yLabel?: string;
  title?: string;
  rebased: boolean;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/;
const TENOR_RE = /^(\d+(?:\.\d+)?)\s*([YMWD])$/i;
const PRICE_Y_RE = /(close|last|spot|px|price|open|high|low)/i;
const SKIP_REBASE_Y_RE = /(^|_)(iv|implied_vol|pct|percent|change|volume|oi|open_interest|yield|rate|bid|ask)(_|$)/i;

export function asPlotNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asDateMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) return null;
  const ms = Date.parse(value.trim().slice(0, 10));
  return Number.isFinite(ms) ? ms : null;
}

function tenorYears(value: string): number | null {
  const match = value.trim().match(TENOR_RE);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'Y') return n;
  if (unit === 'M') return n / 12;
  if (unit === 'W') return n / 52;
  return n / 365;
}

function compareX(a: unknown, b: unknown, numericX: boolean, dateX: boolean): number {
  if (numericX) return (asPlotNumber(a) ?? 0) - (asPlotNumber(b) ?? 0);
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (dateX) return (asDateMs(left) ?? 0) - (asDateMs(right) ?? 0);
  const tenorA = tenorYears(left);
  const tenorB = tenorYears(right);
  if (tenorA != null && tenorB != null) return tenorA - tenorB;
  return left.localeCompare(right);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function downsample(rows: QueryPlotRow[], maxPoints: number): QueryPlotRow[] {
  if (rows.length <= maxPoints) return rows;
  const bySeries = new Map<string, QueryPlotRow[]>();
  for (const row of rows) {
    const list = bySeries.get(row.series) ?? [];
    list.push(row);
    bySeries.set(row.series, list);
  }
  const out: QueryPlotRow[] = [];
  for (const list of bySeries.values()) {
    if (list.length <= maxPoints) {
      out.push(...list);
      continue;
    }
    const stride = (list.length - 1) / (maxPoints - 1);
    const kept: QueryPlotRow[] = [];
    for (let i = 0; i < maxPoints; i++) {
      kept.push(list[Math.round(i * stride)]!);
    }
    if (kept[kept.length - 1] !== list[list.length - 1]) kept[kept.length - 1] = list[list.length - 1]!;
    out.push(...kept);
  }
  return out;
}

function meltWide(result: QueryResult, spec: ChartSpec): { rows: Record<string, unknown>[]; y: string; series: string } | null {
  if (!isWideMeasure(spec.y)) return null;
  const siblings = siblingMeasureColumns(result.columns, spec, result.rows);
  if (siblings.length < 1 || siblings.length > CHART_MAX_SERIES) return null;
  const measures = [spec.y, ...siblings];
  const rows: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    for (const measure of measures) {
      rows.push({
        ...row,
        __chart_y: row[measure],
        __chart_series: measure.toUpperCase(),
      });
    }
  }
  return { rows, y: '__chart_y', series: '__chart_series' };
}

function meltCompanionBars(result: QueryResult, spec: ChartSpec): { rows: Record<string, unknown>[]; y: string; series: string } | null {
  if (spec.kind !== 'bar' || spec.series) return null;
  const other = companionBarMeasures(result.columns, spec.y);
  if (!other) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of result.rows) {
    rows.push({ ...row, __chart_y: row[spec.y], __chart_series: humanizeColumn(spec.y) });
    rows.push({ ...row, __chart_y: row[other], __chart_series: humanizeColumn(other) });
  }
  return { rows, y: '__chart_y', series: '__chart_series' };
}

function shouldRebase(rows: QueryPlotRow[], seriesNames: string[], yName: string, kind: ChartKind): boolean {
  if (kind !== 'line' && kind !== 'area') return false;
  if (seriesNames.length < 2) return false;
  if (SKIP_REBASE_Y_RE.test(yName)) return false;
  const medians: number[] = [];
  for (const name of seriesNames) {
    const values = rows.filter((row) => row.series === name).map((row) => row.y);
    if (values.length < 2) return false;
    const mid = median(values);
    if (mid == null || mid <= 0) return false;
    medians.push(mid);
  }
  const max = Math.max(...medians);
  const min = Math.min(...medians);
  if (min <= 0 || max / min < 2.5) return false;
  if (PRICE_Y_RE.test(yName)) return true;
  return medians.every((value) => value > 5);
}

function rebaseToHundred(rows: QueryPlotRow[]): QueryPlotRow[] {
  const first = new Map<string, number>();
  for (const row of rows) {
    if (!first.has(row.series) && row.y !== 0) first.set(row.series, row.y);
  }
  return rows.map((row) => {
    const base = first.get(row.series);
    if (base == null || base === 0) return row;
    return { ...row, y: (row.y / base) * 100 };
  });
}

function capSeries(rows: QueryPlotRow[], seriesNames: string[]): { rows: QueryPlotRow[]; seriesNames: string[] } {
  if (seriesNames.length <= CHART_MAX_SERIES) return { rows, seriesNames };
  const kept = new Set(seriesNames.slice(0, CHART_MAX_SERIES));
  return {
    rows: rows.filter((row) => kept.has(row.series)),
    seriesNames: seriesNames.slice(0, CHART_MAX_SERIES),
  };
}

function chooseKind(
  kind: ChartKind,
  rows: QueryPlotRow[],
  seriesNames: string[],
  numericX: boolean,
): ChartKind {
  if (kind === 'bar' || kind === 'scatter') return kind;
  const pointsPerSeries = seriesNames.map((name) => rows.filter((row) => row.series === name).length);
  const singlePoints = pointsPerSeries.length > 0 && pointsPerSeries.every((count) => count <= 1);
  const distinctX = new Set(rows.map((row) => String(row.x))).size;
  if (singlePoints || distinctX <= 1) return numericX ? 'scatter' : 'bar';
  return kind;
}

/** Long-form rows for TanStack `z` grouping (one series per distinct series value). */
export function buildQueryPlotRows(result: QueryResult, spec: ChartSpec): QueryPlotData {
  const normalized = normalizeChartSpec(spec, result.columns, result.rows) ?? spec;
  const wide = !normalized.series ? meltWide(result, normalized) : null;
  const companion = !wide ? meltCompanionBars(result, normalized) : null;
  const melted = wide ?? companion;
  const source = melted?.rows ?? result.rows;
  const yCol = melted?.y ?? normalized.y;
  const seriesCol = melted?.series ?? normalized.series;
  const dateX = source.length > 0 && source.every((row) => asDateMs(row[normalized.x]) != null);
  const numericX = !dateX && source.length > 0 && source.every((row) => asPlotNumber(row[normalized.x]) != null);

  const sorted = [...source].sort((a, b) => compareX(a[normalized.x], b[normalized.x], numericX, dateX));
  const byKey = new Map<string, QueryPlotRow>();
  const order: string[] = [];
  const seriesNames: string[] = [];
  const seenSeries = new Set<string>();
  for (const row of sorted) {
    const y = asPlotNumber(row[yCol]);
    if (y == null) continue;
    const x = numericX ? (asPlotNumber(row[normalized.x]) ?? 0) : String(row[normalized.x] ?? '');
    const series = seriesCol ? String(row[seriesCol]) : normalized.y;
    if (!seenSeries.has(series)) {
      seenSeries.add(series);
      seriesNames.push(series);
    }
    const id = `${series}\0${numericX ? String(x) : x}`;
    if (!byKey.has(id)) order.push(id);
    byKey.set(id, { x, y, series });
  }

  let rows = order.map((id) => byKey.get(id)!);
  const capped = capSeries(rows, seriesNames);
  rows = downsample(capped.rows, CHART_MAX_POINTS);
  const kind = chooseKind(normalized.kind, rows, capped.seriesNames, numericX);
  const rebased = shouldRebase(rows, capped.seriesNames, normalized.y, kind);
  if (rebased) rows = rebaseToHundred(rows);

  return {
    rows,
    seriesNames: capped.seriesNames,
    numericX,
    kind,
    title: normalized.title,
    xLabel: normalized.xLabel,
    yLabel: rebased ? 'Indexed (first = 100)' : normalized.yLabel,
    rebased,
  };
}

function fmtXTick(value: unknown, dateX: boolean): string {
  if (dateX && typeof value === 'string') {
    const ms = asDateMs(value);
    if (ms != null) {
      return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }
  return fmtPlotTick(value);
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
  const dateX = !input.numericX && input.rows.length > 0 && input.rows.every((row) => asDateMs(row.x) != null);
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
            axis: mutedAxis((value) => fmtXTick(value, dateX), { label: input.xLabel, minGap: dateX ? 44 : 36 }),
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
