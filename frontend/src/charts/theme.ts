import { d3Curve } from '@tanstack/charts';
import { curveMonotoneX, curveStepAfter } from 'd3-shape';

export const CHART_HOST_CLASS = 'lobster-chart';

/** Inherited by TanStack Charts for axes, grids, and the default categorical palette. */
export const lobsterChartTheme = {
  foreground: 'var(--color-text-secondary)',
  muted: 'var(--color-text-secondary)',
  grid: 'var(--color-border)',
  background: 'transparent',
  palette: [
    'var(--color-accent)',
    'var(--color-icon-blue)',
    'var(--color-warning)',
    'var(--color-success)',
    'var(--color-error)',
    'var(--color-text-blue)',
  ],
} as const;

export const monotoneX = d3Curve(curveMonotoneX);
export const stepAfter = d3Curve(curveStepAfter);

export function fmtPlotTick(value: unknown): string {
  if (typeof value !== 'number') return String(value);
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function fmtPrice(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtUsd(value: number, digits = 2): string {
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
  });
}

export function mutedAxis<TValue>(
  format: (value: TValue) => string,
  options?: { label?: string; minGap?: number },
) {
  return {
    line: false,
    ticks: {
      size: 0,
      format,
    },
    tickLabels: {
      fontSize: 10,
      ...(options?.minGap != null ? { thin: { minGap: options.minGap } } : {}),
    },
    ...(options?.label ? { label: options.label } : {}),
  };
}
