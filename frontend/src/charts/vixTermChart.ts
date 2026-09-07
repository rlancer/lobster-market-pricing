import { colorLegend, defineChart, lineY } from '@tanstack/charts';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import type { VixCurvePoint, VixHistoryCurve } from '../api.ts';
import { fmtPrice, lobsterChartTheme, monotoneX, mutedAxis } from './theme.ts';
import { tenorChartLabel } from '../vixPage.ts';

/** Cash VIX → M1, matching vixcentral's dashed spot leg. */
export const VIX_SPOT_DASHARRAY = '6 4';

export interface VixTermPlotRow {
  x: string;
  y: number;
  series: string;
  tenor: number;
}

export function vixTermPlotRows(input: {
  primaryLabel: string;
  curve: VixCurvePoint[];
  history: VixHistoryCurve[];
  overlayDates: string[];
}): VixTermPlotRow[] {
  const rows: VixTermPlotRow[] = [];
  const pushCurve = (label: string, points: VixCurvePoint[]) => {
    for (const point of points) {
      if (point.last == null || !Number.isFinite(point.last)) continue;
      rows.push({
        x: tenorChartLabel(point.tenor),
        y: point.last,
        series: label,
        tenor: point.tenor,
      });
    }
  };
  pushCurve(input.primaryLabel, input.curve);
  const selected = new Set(input.overlayDates);
  for (const curve of input.history) {
    if (!selected.has(curve.date)) continue;
    pushCurve(curve.date, curve.points);
  }
  rows.sort((a, b) => {
    if (a.tenor !== b.tenor) return a.tenor - b.tenor;
    if (a.series === input.primaryLabel) return -1;
    if (b.series === input.primaryLabel) return 1;
    return a.series.localeCompare(b.series);
  });
  return rows;
}

/** Spot plus the front monthly, so the cash-VIX connector can be dashed. */
export function vixTermSpotLeg(rows: VixTermPlotRow[]): VixTermPlotRow[] {
  const m1 = new Map<string, VixTermPlotRow>();
  const spots: VixTermPlotRow[] = [];
  for (const row of rows) {
    if (row.tenor === 0) spots.push(row);
    else if (row.tenor === 1 && !m1.has(row.series)) m1.set(row.series, row);
  }
  const out: VixTermPlotRow[] = [];
  for (const spot of spots) {
    out.push(spot);
    const front = m1.get(spot.series);
    if (front) out.push(front);
  }
  return out;
}

/** VX monthals only — solid curve from M1 out. */
export function vixTermFutureLeg(rows: VixTermPlotRow[]): VixTermPlotRow[] {
  return rows.filter((row) => row.tenor >= 1);
}

export function defineVixTermChart(rows: VixTermPlotRow[]) {
  const seriesNames = [...new Set(rows.map((row) => row.series))];
  const xOrder = [...new Set(rows.map((row) => row.x))];
  const multi = seriesNames.length > 1;
  const spotLeg = vixTermSpotLeg(rows);
  const futureLeg = vixTermFutureLeg(rows);
  const lineOpts = {
    x: 'x' as const,
    y: 'y' as const,
    z: 'series' as const,
    color: 'series' as const,
    strokeWidth: 2,
    curve: monotoneX,
  };
  return defineChart({
    marks: [
      ...(spotLeg.length
        ? [lineY(spotLeg, {
          ...lineOpts,
          key: (row) => `${row.series}:spot:${row.x}`,
          strokeDasharray: VIX_SPOT_DASHARRAY,
        })]
        : []),
      ...(futureLeg.length
        ? [lineY(futureLeg, {
          ...lineOpts,
          key: (row) => `${row.series}:vx:${row.x}`,
        })]
        : []),
    ],
    scales: {
      x: {
        scale: () => scalePoint<string>().padding(0.12),
        domain: xOrder,
        axis: mutedAxis((value: string | number) => String(value), {
          label: 'Tenor',
          minGap: 28,
        }),
      },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: mutedAxis((value: number) => fmtPrice(Number(value), 1), { label: 'VX' }),
      },
    },
    theme: lobsterChartTheme,
    ...(multi ? { color: { legend: colorLegend({ placement: 'bottom' }) } } : {}),
    svgAnimation: false,
    focus: 'nearest-x',
    maxFocusDistance: Number.POSITIVE_INFINITY,
    tooltip: {
      use: tooltip,
      className: 'lobster-chart-tooltip',
    },
  });
}
