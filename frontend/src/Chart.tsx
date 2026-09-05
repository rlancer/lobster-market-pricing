// Chart renderer for the chat. The model returns a `render_chart` tool call
// with a ChartSpec describing how to plot the most recent query result; this
// component turns that (spec + captured rows) into a TanStack chart inside the
// chat bubble. Line/area/scatter/bar, plus multi-series grouping (series
// column) — which is how the model renders a volatility surface: x=strike,
// y=implied_vol, series=expiration → one curve per tenor.
import { Component, useMemo, type ReactNode } from 'react';
import { Chart } from '@tanstack/charts/react';
import type { QueryResult } from './api';
import { buildQueryPlotRows, defineQueryChart } from './charts/queryChart';
import { CHART_HOST_CLASS } from './charts/theme';
import type { ChartKind, ChartSpec } from './chartSpec';
import './charts.css';

export type { ChartKind, ChartSpec } from './chartSpec';

const KINDS = new Set<ChartKind>(['line', 'area', 'scatter', 'bar']);

class ChartPlotBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="ai-chart ai-chart-empty">
          Couldn't chart — {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export function ChartView({ result, spec }: { result: QueryResult; spec: ChartSpec }) {
  const kind: ChartKind = spec.kind && KINDS.has(spec.kind) ? spec.kind : 'line';
  const data = useMemo(() => buildQueryPlotRows(result, { ...spec, kind }), [result, spec, kind]);

  const colSet = new Set(result.columns);
  const definition = useMemo(
    () => defineQueryChart({
      rows: data.rows,
      kind,
      numericX: data.numericX,
      seriesNames: data.seriesNames,
      xLabel: spec.xLabel,
      yLabel: spec.yLabel,
    }),
    [data, kind, spec.xLabel, spec.yLabel],
  );

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

  return (
    <ChartPlotBoundary key={`${kind}:${spec.x}:${spec.y}:${spec.series ?? ''}:${data.rows.length}`}>
      <div className="ai-chart">
        {spec.title && <div className="ai-chart-title">{spec.title}</div>}
        <div className="ai-chart-body">
          <Chart
            definition={definition}
            height={280}
            ariaLabel={spec.title ?? `${spec.y} vs ${spec.x}`}
            className={CHART_HOST_CLASS}
          />
        </div>
      </div>
    </ChartPlotBoundary>
  );
}
