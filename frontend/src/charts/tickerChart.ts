import { defineChart, lineY, ruleY, text } from '@tanstack/charts';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scalePoint } from '@tanstack/charts/scales/point';
import { tooltip } from '@tanstack/charts/tooltip';
import type { OhlcBar } from '../api.ts';
import { formatChartTick } from '../tickerChartRange.ts';
import { fmtPrice, lobsterChartTheme, monotoneX, mutedAxis } from './theme.ts';

export function tickerCloses(bars: OhlcBar[]): Array<{ date: string; close: number }> {
  return bars.flatMap((bar) => (
    bar.close != null && Number.isFinite(bar.close)
      ? [{ date: bar.date, close: bar.close }]
      : []
  ));
}

export function defineTickerChart(input: {
  rows: Array<{ date: string; close: number }>;
  spot: number | null;
  isIntraday: boolean;
}) {
  const priceLabel = input.isIntraday ? 'price' : 'close';
  const last = input.rows.at(-1);
  const spot = input.spot != null && Number.isFinite(input.spot) ? input.spot : null;
  const marks = [
    lineY(input.rows, {
      x: 'date',
      y: 'close',
      key: 'date',
      stroke: 'var(--color-accent)',
      strokeWidth: 1.5,
      curve: monotoneX,
    }),
    ...(spot != null
      ? [
          ruleY([spot], {
            stroke: 'var(--color-accent)',
            strokeDasharray: '3 3',
            strokeOpacity: 1,
          }),
          ...(last
            ? [text(
                [{ date: last.date, close: spot, label: `spot ${fmtPrice(spot)}` }],
                {
                  x: 'date',
                  y: 'close',
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
  ] as const;

  return defineChart({
    marks,
    scales: {
      x: {
        scale: () => scalePoint<string>().padding(0.04),
        axis: mutedAxis((value: string | number) => formatChartTick(String(value)), {
          minGap: input.isIntraday ? 36 : 48,
        }),
      },
      y: {
        scale: scaleLinear,
        nice: true,
        axis: mutedAxis((value: number) => fmtPrice(Number(value), 0)),
      },
    },
    theme: lobsterChartTheme,
    svgAnimation: false,
    focus: 'nearest-x',
    maxFocusDistance: Number.POSITIVE_INFINITY,
    tooltip: {
      use: tooltip,
      className: 'lobster-chart-tooltip',
      items: [
        {
          channel: 'x',
          text: (point) => (
            input.isIntraday
              ? `Price · ${String(point.xValue)}`
              : `Close · ${String(point.xValue)}`
          ),
        },
        {
          channel: 'y',
          label: priceLabel,
          text: (point) => fmtPrice(Number(point.yValue), 2),
        },
      ],
    },
  });
}
