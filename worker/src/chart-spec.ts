export interface ChartSpec {
  title?: string;
  kind: "line" | "area" | "scatter" | "bar";
  x: string;
  y: string;
  series?: string;
  xLabel?: string;
  yLabel?: string;
}

const CHART_REQUEST_RE = /\b(chart|graph|plot|smile|surface|visuali[sz]e|histogram)\b/i;
const X_PREF = ["strike", "expiration", "dte", "as_of_date", "trade_date", "date", "tenor", "moneyness", "delta", "symbol", "ticker"];
const Y_PREF = ["implied_vol", "iv", "open_interest", "volume", "premium", "spot_price", "pct_chg", "last", "close", "value"];
const SERIES_PREF = ["type", "expiration", "symbol", "ticker", "series_id"];
const CATEGORY_X = new Set(["symbol", "ticker", "contract", "name", "tenor"]);
const CATEGORY_SERIES = new Set(["symbol", "ticker", "contract", "name", "type", "expiration", "series_id"]);
const RESERVED_MEASURE = new Set([
  "volume", "open_interest", "oi", "implied_vol", "iv", "delta", "gamma", "theta",
  "vega", "rho", "bid", "ask", "last", "open", "high", "low", "close", "spot_price",
  "premium", "pct_chg", "delta_pct", "yes_bid", "yes_ask",
]);
const X_LIKE = new Set([
  "strike", "expiration", "dte", "as_of_date", "trade_date", "date", "moneyness",
  "delta", "symbol", "ticker", "contract", "tenor", "x", "series_id", "type",
]);
const COLUMN_LABELS: Record<string, string> = {
  implied_vol: "Implied vol",
  iv: "Implied vol",
  open_interest: "Open interest",
  oi: "Open interest",
  pct_chg: "% change",
  spot_price: "Spot",
  as_of_date: "Date",
  trade_date: "Date",
  series_id: "Series",
  yes_bid: "Yes bid",
  realized_vol_30d: "30d realized vol",
  realized_vol_90d: "90d realized vol",
};

/** Soft cap the model should stay under; the renderer also downsamples. */
export const CHART_MAX_SERIES = 12;
export const CHART_MAX_POINTS = 160;

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

export function humanizeColumn(name: string): string {
  const mapped = COLUMN_LABELS[name.toLowerCase()];
  if (mapped) return mapped;
  return name.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Number(value));
}

export function numericColumns(columns: string[], rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return [];
  return columns.filter((column) => rows.some((row) => isNumeric(row[column])));
}

export function distinctCount(rows: Record<string, unknown>[], column: string): number {
  return new Set(rows.map((row) => String(row[column] ?? ""))).size;
}

export function isUsefulSeries(rows: Record<string, unknown>[], column: string): boolean {
  if (!rows.length) return true;
  const n = distinctCount(rows, column);
  if (n < 2 || n > CHART_MAX_SERIES + 4) return false;
  if (CATEGORY_SERIES.has(column.toLowerCase())) return true;
  if (rows.length > 4 && n === rows.length) return false;
  return true;
}

export function isWideMeasure(column: string): boolean {
  return !RESERVED_MEASURE.has(column.toLowerCase()) && !X_LIKE.has(column.toLowerCase());
}

/** Parallel numeric columns that should be unpivoted instead of plotting one wide field. */
export function siblingMeasureColumns(
  columns: string[],
  spec: Pick<ChartSpec, "x" | "y">,
  rows: Record<string, unknown>[],
): string[] {
  const y = resolveColumn(columns, spec.y);
  const x = resolveColumn(columns, spec.x);
  if (!y) return [];
  return numericColumns(columns, rows).filter((column) => {
    if (column === x || column === y) return false;
    const lower = column.toLowerCase();
    if (X_LIKE.has(lower) || RESERVED_MEASURE.has(lower)) return false;
    return true;
  });
}

export function companionBarMeasures(columns: string[], y: string): string | null {
  const resolved = resolveColumn(columns, y);
  if (!resolved) return null;
  const lower = resolved.toLowerCase();
  if (lower === "volume") {
    return resolveColumn(columns, "open_interest") ?? resolveColumn(columns, "oi");
  }
  if (lower === "open_interest" || lower === "oi") return resolveColumn(columns, "volume");
  return null;
}

/**
 * Resolve columns, drop a measure-used-as-series, and replace raw `y vs x`
 * titles/labels. Returns null when the result cannot plot.
 */
export function normalizeChartSpec(
  spec: ChartSpec,
  columns: string[],
  rows: Record<string, unknown>[] = [],
): ChartSpec | null {
  const x = resolveColumn(columns, spec.x);
  const y = resolveColumn(columns, spec.y);
  if (!x || !y) return null;
  let series = spec.series ? resolveColumn(columns, spec.series) ?? undefined : undefined;
  if (series && (series === x || series === y || !isUsefulSeries(rows, series))) series = undefined;
  const kind = spec.kind === "area" || spec.kind === "scatter" || spec.kind === "bar" ? spec.kind : "line";
  const rawTitle = spec.title?.trim() ?? "";
  const rawXLabel = spec.xLabel?.trim() ?? "";
  const rawYLabel = spec.yLabel?.trim() ?? "";
  const genericTitle = !rawTitle || rawTitle.toLowerCase() === `${y} vs ${x}`.toLowerCase();
  return {
    kind,
    x,
    y,
    ...(series ? { series } : {}),
    title: genericTitle ? `${humanizeColumn(y)} vs ${humanizeColumn(x)}` : rawTitle,
    xLabel: !rawXLabel || rawXLabel === x ? humanizeColumn(x) : rawXLabel,
    yLabel: !rawYLabel || rawYLabel === y ? humanizeColumn(y) : rawYLabel,
  };
}

export function critiqueChartSpec(
  spec: ChartSpec,
  columns: string[],
  rows: Record<string, unknown>[],
): { ok: true; spec: ChartSpec; notes: string[] } | { ok: false; error: string } {
  const x = resolveColumn(columns, spec.x);
  const y = resolveColumn(columns, spec.y);
  if (!x || !y) {
    return { ok: false, error: `Result lacks '${spec.x}' or '${spec.y}'. Available columns: ${columns.join(", ") || "(none)"}.` };
  }
  if (rows.length === 0) return { ok: false, error: "No rows to chart." };
  if (!rows.some((row) => isNumeric(row[y]))) {
    return { ok: false, error: `Column '${y}' has no numeric values to plot.` };
  }
  if (spec.series && !resolveColumn(columns, spec.series)) {
    return { ok: false, error: `Result lacks series column '${spec.series}'. Available columns: ${columns.join(", ")}.` };
  }
  const normalized = normalizeChartSpec(spec, columns, rows);
  if (!normalized) return { ok: false, error: `Result lacks '${spec.x}' or '${spec.y}'.` };
  const notes: string[] = [];
  if (spec.series && !normalized.series) {
    notes.push(`Dropped series '${spec.series}' — series must be a low-cardinality category (symbol, type, expiration, series_id), not a measure.`);
  }
  const siblings = siblingMeasureColumns(columns, normalized, rows);
  if (!normalized.series && siblings.length >= 1 && siblings.length <= CHART_MAX_SERIES) {
    notes.push(`Wide table (${[normalized.y, ...siblings].join(", ")}). Unpivot to long form (date, series, value) or the UI will melt these columns.`);
  }
  return { ok: true, spec: normalized, notes };
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
    .filter((column): column is string => Boolean(column && column !== x && column !== y && isUsefulSeries(rows, column)));
  const expiration = lower.get("expiration");
  const optionType = lower.get("type");
  let series: string | undefined;
  if (expiration && expiration !== x && expiration !== y && isUsefulSeries(rows, expiration)) series = expiration;
  else if (optionType && optionType !== x && optionType !== y && isUsefulSeries(rows, optionType)) series = optionType;
  else series = seriesCandidates[0];
  const kind = CATEGORY_X.has(x.toLowerCase()) ? "bar" : "line";
  return normalizeChartSpec({
    kind,
    x,
    y,
    ...(series ? { series } : {}),
  }, columns, rows);
}
