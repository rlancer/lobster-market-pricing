import { areaY, barY, defineChart, dot, lineY, ruleY } from '@tanstack/charts';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleOrdinal } from '@tanstack/charts/scales/ordinal';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import { formatChartTick } from '../tickerChartRange';
import { fmtUsd, lobsterChartTheme, mutedAxis, stepAfter } from './theme';

export type PnlMetric = 'daily' | 'cumulative';

export interface PnlChartPoint {
  date: string;
  daily: number;
  cumulative: number;
}

export interface PnlChartMarker extends PnlChartPoint {
  kind: 'stock' | 'option' | 'dividend';
  label: string;
}

const MARKER_COLOR = scaleOrdinal(
  ['stock', 'option', 'dividend'] as const,
  ['var(--color-accent)', 'var(--color-warning)', 'var(--color-success)'],
);

function dailyMarks(series: readonly PnlChartPoint[], markers: readonly PnlChartMarker[]) {
  return [
    ruleY([0], {
      stroke: 'var(--color-border)',
      strokeOpacity: 1,
    }),
    barY(series, {
      x: 'date',
      y: 'daily',
      y1: 0,
      key: 'date',
      fill: (row) => (
        row.daily >= 0 ? 'var(--color-success)' : 'var(--color-error)'
      ),
      maxThickness: 28,
      radius: 2,
    }),
    ...(markers.length > 0
      ? [dot(markers, {
          x: 'date',
          y: 'daily',
          color: 'kind',
          key: (row) => `${row.date}:${row.kind}:${row.label}`,
          r: 3.5,
        })]
      : []),
  ] as const;
}

function cumulativeMarks(series: readonly PnlChartPoint[], markers: readonly PnlChartMarker[]) {
  return [
    ruleY([0], {
      stroke: 'var(--color-border)',
      strokeOpacity: 1,
    }),
    areaY(series, {
      x: 'date',
      y: 'cumulative',
      y1: 0,
      fill: 'var(--color-accent)',
      fillOpacity: 0.12,
      curve: stepAfter,
    }),
    lineY(series, {
      x: 'date',
      y: 'cumulative',
      key: 'date',
      stroke: 'var(--color-accent)',
      strokeWidth: 2,
      curve: stepAfter,
    }),
    ...(markers.length > 0
      ? [dot(markers, {
          x: 'date',
          y: 'cumulative',
          color: 'kind',
          key: (row) => `${row.date}:${row.kind}:${row.label}`,
          r: 3.5,
        })]
      : []),
  ] as const;
}

export function definePnlChart(input: {
  series: readonly PnlChartPoint[];
  markers: readonly PnlChartMarker[];
  metric: PnlMetric;
  domain: readonly [number, number];
}) {
  const valueLabel = input.metric === 'cumulative' ? 'Cumulative P&L' : 'Day P&L';
  const scales = {
    x: {
      scale: input.metric === 'daily'
        ? () => scaleBand<string>().padding(0.2)
        : () => scalePoint<string>().padding(0.04),
      axis: mutedAxis((value: string | number) => formatChartTick(String(value)), { minGap: 48 }),
    },
    y: {
      scale: scaleLinear().domain([input.domain[0], input.domain[1]]),
      grid: true,
      axis: mutedAxis((value: number) => fmtUsd(Number(value), 0)),
    },
  };
  const shared = {
    color: { scale: MARKER_COLOR },
    theme: lobsterChartTheme,
    svgAnimation: false as const,
    focus: 'nearest-x' as const,
    tooltip: {
      use: tooltip,
      className: 'lobster-chart-tooltip',
      items: [
        { channel: 'x' as const },
        {
          channel: 'y' as const,
          label: valueLabel,
          text: (point: { yValue: unknown }) => fmtUsd(Number(point.yValue)),
        },
      ],
    },
  };

  if (input.metric === 'daily') {
    return defineChart({
      marks: dailyMarks(input.series, input.markers),
      scales,
      ...shared,
    });
  }
  return defineChart({
    marks: cumulativeMarks(input.series, input.markers),
    scales,
    ...shared,
  });
}
