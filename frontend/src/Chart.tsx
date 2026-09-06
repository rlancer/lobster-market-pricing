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
import { resolveColumn, type ChartSpec } from './chartSpec';
import './charts.css';

export type { ChartKind, ChartSpec } from './chartSpec';

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
  const x = resolveColumn(result.columns, spec.x);
  const y = resolveColumn(result.columns, spec.y);
  const data = useMemo(
    () => (x && y ? buildQueryPlotRows(result, spec) : null),
    [result, spec, x, y],
  );

  const definition = useMemo(
    () => data
      ? defineQueryChart({
          rows: data.rows,
          kind: data.kind,
          numericX: data.numericX,
          seriesNames: data.seriesNames,
          xLabel: data.xLabel,
          yLabel: data.yLabel,
        })
      : null,
    [data],
  );

  if (!x || !y) {
    return (
      <div className="ai-chart ai-chart-empty">
        Couldn't chart — the query result has no column(s) {spec.x}/{spec.y}.
      </div>
    );
  }
  if (!data || data.rows.length === 0) {
    return <div className="ai-chart ai-chart-empty">No data to chart.</div>;
  }

  const title = data.title ?? spec.title;
  return (
    <ChartPlotBoundary key={`${data.kind}:${spec.x}:${spec.y}:${spec.series ?? ''}:${data.rows.length}:${data.rebased}`}>
      <div className="ai-chart">
        {title && <div className="ai-chart-title">{title}</div>}
        <div className="ai-chart-body">
          <Chart
            definition={definition!}
            height={280}
            ariaLabel={title ?? `${spec.y} vs ${spec.x}`}
            className={CHART_HOST_CLASS}
          />
        </div>
      </div>
    </ChartPlotBoundary>
  );
}
