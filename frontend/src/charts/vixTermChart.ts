import { colorLegend, defineChart, lineY, ruleY, text } from '@tanstack/charts';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import type { VixCurvePoint, VixHistoryCurve } from '../api.ts';
import { fmtPrice, lobsterChartTheme, monotoneX, mutedAxis } from './theme.ts';
import { tenorChartLabel } from '../vixPage.ts';

/** Horizontal cash-VIX reference so futures sit above/below spot. */
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

/** Cash VIX for the primary series — drawn as a horizontal reference. */
export function vixTermSpotLevel(rows: VixTermPlotRow[], primaryLabel: string): number | null {
  const spot = rows.find((row) => row.series === primaryLabel && row.tenor === 0);
  return spot != null && Number.isFinite(spot.y) ? spot.y : null;
}

/** VX monthals only — the curve in front of the spot line. */
export function vixTermFutureLeg(rows: VixTermPlotRow[]): VixTermPlotRow[] {
  return rows.filter((row) => row.tenor >= 1);
}

export function defineVixTermChart(rows: VixTermPlotRow[], primaryLabel: string) {
  const futureLeg = vixTermFutureLeg(rows);
  const spot = vixTermSpotLevel(rows, primaryLabel);
  const seriesNames = [...new Set(futureLeg.map((row) => row.series))];
  const xOrder = [...new Set(futureLeg.map((row) => row.x))];
  const multi = seriesNames.length > 1;
  const lastX = xOrder.at(-1);
  return defineChart({
    marks: [
      ...(futureLeg.length
        ? [lineY(futureLeg, {
          x: 'x',
          y: 'y',
          z: 'series',
          color: 'series',
          key: (row) => `${row.series}:${row.x}`,
          strokeWidth: 2,
          curve: monotoneX,
        })]
        : []),
      ...(spot != null
        ? [
            ruleY([spot], {
              stroke: 'var(--color-accent)',
              strokeDasharray: VIX_SPOT_DASHARRAY,
              strokeOpacity: 1,
              strokeWidth: 1.5,
            }),
            ...(lastX
              ? [text(
                  [{ x: lastX, y: spot, label: `VIX ${fmtPrice(spot)}` }],
                  {
                    x: 'x',
                    y: 'y',
                    text: 'label',
                    fill: 'var(--color-accent)',
                    fontSize: 10,
                    anchor: 'end' as const,
                    dy: -8,
                  },
                )]
              : []),
          ]
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
