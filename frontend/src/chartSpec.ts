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

const CHART_REQUEST_RE = /\b(chart|graph|plot|smile|surface|visuali[sz]e|histogram)\b/i;
const X_PREF = ['strike', 'expiration', 'dte', 'as_of_date', 'date', 'moneyness', 'delta'];
const Y_PREF = ['implied_vol', 'iv', 'open_interest', 'volume', 'premium', 'spot_price', 'last', 'close'];
const SERIES_PREF = ['type', 'expiration', 'symbol'];

export function wantsChart(question: string): boolean {
  return CHART_REQUEST_RE.test(question);
}

export function resolveColumn(columns: string[], name: string): string | null {
  if (columns.includes(name)) return name;
  const lower = name.toLowerCase();
  return columns.find((column) => column.toLowerCase() === lower) ?? null;
}

export function chartFitsResult(chart: ChartSpec, columns: string[]): boolean {
  return Boolean(resolveColumn(columns, chart.x) && resolveColumn(columns, chart.y) && (!chart.series || resolveColumn(columns, chart.series)));
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Number(value));
}

function numericColumns(columns: string[], rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return [];
  return columns.filter((column) => rows.some((row) => isNumeric(row[column])));
}

function distinctCount(rows: Record<string, unknown>[], column: string): number {
  return new Set(rows.map((row) => String(row[column] ?? ''))).size;
}

/** Best-effort spec when the model asked for a chart but skipped render_chart. */
export function inferChartSpec(columns: string[], rows: Record<string, unknown>[]): ChartSpec | null {
  if (!columns.length || !rows.length) return null;
  const lower = new Map(columns.map((column) => [column.toLowerCase(), column]));
  const pick = (names: string[], exclude?: string) =>
    names.map((name) => lower.get(name)).find((column) => column && column !== exclude);
  const numeric = numericColumns(columns, rows);
  const x = pick(X_PREF) ?? numeric[0];
  const y = pick(Y_PREF, x) ?? numeric.find((column) => column !== x);
  if (!x || !y || x === y) return null;
  const seriesCandidates = SERIES_PREF
    .map((name) => lower.get(name))
    .filter((column): column is string => Boolean(column && column !== x && column !== y));
  const expiration = lower.get('expiration');
  const optionType = lower.get('type');
  let series: string | undefined;
  if (expiration && expiration !== x && expiration !== y && distinctCount(rows, expiration) > 1) series = expiration;
  else if (optionType && optionType !== x && optionType !== y && distinctCount(rows, optionType) > 1) series = optionType;
  else series = seriesCandidates.find((column) => distinctCount(rows, column) > 1);
  return {
    kind: 'line',
    x,
    y,
    ...(series ? { series } : {}),
    title: `${y} vs ${x}`,
    xLabel: x,
    yLabel: y,
  };
}
