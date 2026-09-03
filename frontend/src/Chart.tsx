// Chart renderer for the chat. The model returns a `render_chart` tool call
// with a ChartSpec describing how to plot the most recent query result; this
// component turns that (spec + captured rows) into a Recharts chart inside the
// chat bubble. Line/area/scatter/bar, plus multi-series grouping (series
// column) — which is how the model renders a volatility surface: x=strike,
// y=implied_vol, series=expiration → one curve per tenor.
import { useMemo, type ElementType } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { QueryResult } from './api';

export type ChartKind = 'line' | 'area' | 'scatter' | 'bar';

export interface ChartSpec {
  /** Short heading shown above the chart. */
  title?: string;
  kind: ChartKind;
  /** Column in the query result to plot on the x-axis. */
  x: string;
  /** Column in the query result to plot on the y-axis. */
  y: string;
  /** Optional column that splits the data into one series per distinct value. */
  series?: string;
  xLabel?: string;
  yLabel?: string;
}

// Shared series palette replays on overflow (repr for recharts, unused here).
const PALETTE = ['var(--accent)', '#4c8dff', '#e0a84c', '#3fbf9e', '#c56e8f', '#9b7ee0', '#58b6c9'];

const VAL_KEY = '__value';

interface BuiltData {
  rows: Record<string, unknown>[];
  seriesKeys: { key: string; name: string }[];
  numericX: boolean;
}

function asPlotNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Turn raw query rows into Recharts data: sorted by x, pivoted by series. */
function build(result: QueryResult, spec: ChartSpec): BuiltData {
  const src = result.rows;
  const numericX = src.length > 0 && src.every((r) => asPlotNumber(r[spec.x]) != null);
  const sorted = [...src].sort((a, b) => {
    if (numericX) return (asPlotNumber(a[spec.x]) ?? 0) - (asPlotNumber(b[spec.x]) ?? 0);
    return String(a[spec.x]).localeCompare(String(b[spec.x]));
  });
  const xOf = (row: Record<string, unknown>) => (numericX ? asPlotNumber(row[spec.x]) : row[spec.x]);
  const yOf = (row: Record<string, unknown>) => {
    const n = asPlotNumber(row[spec.y]);
    return n == null ? row[spec.y] : n;
  };

  if (!spec.series) {
    return {
      rows: sorted.map((r) => ({ x: xOf(r), [VAL_KEY]: yOf(r) })),
      seriesKeys: [{ key: VAL_KEY, name: spec.y }],
      numericX,
    };
  }

  const seriesNameSet = new Set<string>();
  for (const r of sorted) seriesNameSet.add(String(r[spec.series]));
  const seriesKeys = [...seriesNameSet].map((k) => ({ key: k, name: k }));

  const byX = new Map<string, Record<string, unknown>>();
  const rows: Record<string, unknown>[] = [];
  const keyOf = (v: unknown) => (numericX ? String(Number(v)) : String(v));
  for (const r of sorted) {
    const xVal = xOf(r);
    const xk = keyOf(xVal);
    let point = byX.get(xk);
    if (!point) {
      point = { x: xVal };
      byX.set(xk, point);
      rows.push(point);
    }
    point[String(r[spec.series])] = yOf(r);
  }
  return { rows, seriesKeys, numericX };
}

function fmtTick(v: unknown): string {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function seriesProps(kind: ChartKind, color: string): Record<string, unknown> {
  if (kind === 'line') {
    return { type: 'monotone', stroke: color, strokeWidth: 2, dot: false, activeDot: { r: 3 }, connectNulls: true, isAnimationActive: false };
  }
  if (kind === 'area') {
    return { type: 'monotone', stroke: color, strokeWidth: 2, fill: color, fillOpacity: 0.15, dot: false, connectNulls: true, isAnimationActive: false };
  }
  if (kind === 'scatter') {
    return { fill: color, fillOpacity: 0.7, stroke: 'none', isAnimationActive: false };
  }
  return { fill: color, radius: [2, 2, 0, 0] as [number, number, number, number], isAnimationActive: false };
}

const CHART_COMPONENTS = {
  line: LineChart,
  area: AreaChart,
  bar: BarChart,
  scatter: ScatterChart,
} as const;
const SERIES_COMPONENTS = {
  line: Line,
  area: Area,
  bar: Bar,
  scatter: Scatter,
} as const;

export function ChartView({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const kind: ChartKind = spec.kind && spec.kind in CHART_COMPONENTS ? spec.kind : 'line';
  const data = useMemo(() => build(result, { ...spec, kind }), [result, spec]);

  const colSet = new Set(result.columns);
  if (!colSet.has(spec.x) || !colSet.has(spec.y)) {
    return (
      <div className="ai-chart ai-chart-empty">
        Couldn't chart — the query result has no column(s) {spec.x}/{spec.y}.
      </div>
    );
  }
  if (data.rows.length === 0) {
    return <div className="ai-chart ai-chart-empty">No data to chart.</div>;
  }

  const Chart = CHART_COMPONENTS[kind];
  // Recharts chart/series elements share no common JSX prop type; the series
  // props are an intentionally loose per-kind spread.
  const Series = SERIES_COMPONENTS[kind] as ElementType;
  const multi = data.seriesKeys.length > 1;

  const xAxisProps = data.numericX
    ? { type: 'number' as const, dataKey: 'x', domain: ['dataMin', 'dataMax'] as [string, string] }
    : { type: 'category' as const, dataKey: 'x' };

  return (
    <div className="ai-chart">
      {spec.title && <div className="ai-chart-title">{spec.title}</div>}
      <div className="ai-chart-body">
        <ResponsiveContainer width="100%" height={280} minWidth={0} minHeight={0}>
          <Chart data={data.rows} margin={{ top: 10, right: 14, bottom: 6, left: 6 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              {...xAxisProps}
              stroke="var(--muted)"
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              tickFormatter={fmtTick}
              label={spec.xLabel ? { value: spec.xLabel, position: 'insideBottom', offset: -4, fill: 'var(--muted)', fontSize: 11 } : undefined}
            />
            <YAxis
              stroke="var(--muted)"
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
              tickFormatter={fmtTick}
              width={56}
              label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft', offset: 8, fill: 'var(--muted)', fontSize: 11 } : undefined}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--panel-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--text)',
              }}
            />
            {multi && <Legend wrapperStyle={{ fontSize: 11, color: 'var(--muted)' }} />}
            {data.seriesKeys.map((s, i) => (
              <Series
                key={s.key}
                dataKey={s.key}
                name={s.name}
                {...(kind === 'scatter' ? { data: data.rows } : {})}
                {...seriesProps(kind, PALETTE[i % PALETTE.length])}
              />
            ))}
          </Chart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
