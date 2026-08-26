/**
 * Frame sketches, tool-result summaries, and parameterized SQLite compilation
 * for filter/reduce. Kept free of Workers-runtime imports so it is unit-testable
 * in plain Node (copilot.ts pulls in @cloudflare/ai-chat + agents).
 */

import { FRAME_QUERY_LIMIT } from "./copilot-contract";

export const MAX_TOOL_SUMMARY_CHARS = 12_000;
export const SAMPLE_HEAD_ROWS = 5;
export const SAMPLE_TAIL_ROWS = 5;
export const SAMPLE_EXTREMA_COLUMNS = 3;
export const TOP_VALUE_LIMIT = 8;
/** Minimum distinct dates + closes per series before we emit a period table. */
export const PERIOD_STATS_MIN_POINTS = 3;
/** Same threshold as the text-vs-image experiment's planted crash day. */
export const PERIOD_STATS_SHARP_DROP_PCT = -12;
/** Cap rows so a huge panel does not crowd out head/tail in the tool summary. */
export const PERIOD_STATS_MAX_SERIES = 40;

export type SqlValue = string | number | boolean | null;

export interface ResultView {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
}

export interface FrameColumnSketch {
  type: "number" | "string" | "boolean" | "other";
  count: number;
  nulls: number;
  min?: number;
  max?: number;
  mean?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  values?: string[];
  top?: { value: string; n: number }[];
}

export interface FrameAggregation {
  fn: "avg" | "sum" | "count" | "min" | "max";
  column?: string;
  as?: string;
}

export interface FrameQueryArgs {
  where?: string;
  sort?: string;
  limit?: number;
  project?: string[];
  group_by?: string[];
  aggregations?: FrameAggregation[];
}

export interface CompiledFrameQuery {
  sql: string;
  values: SqlValue[];
  columns: string[];
}

type ExprNode =
  | { type: "literal"; value: unknown }
  | { type: "column"; name: string }
  | { type: "unary"; op: "!" | "-"; value: ExprNode }
  | { type: "binary"; op: string; left: ExprNode; right: ExprNode }
  | { type: "call"; name: string; args: ExprNode[] };

interface ExprToken {
  type: "number" | "string" | "identifier" | "operator" | "punctuation" | "eof";
  value: string;
}

interface SqlExpr {
  sql: string;
  values: SqlValue[];
}

type ColumnCompile = (name: string) => SqlExpr;

const JSON_COLUMN: ColumnCompile = (name) => ({ sql: "json_extract(row_json, ?)", values: [jsonPath(name)] });
const ALIAS_COLUMN: ColumnCompile = (name) => ({ sql: quoteIdent(name), values: [] });

const AGG_SQL: Record<FrameAggregation["fn"], string> = {
  avg: "AVG",
  sum: "SUM",
  count: "COUNT",
  min: "MIN",
  max: "MAX",
};

export function jsonPath(column: string): string {
  return `$.${JSON.stringify(column)}`;
}

function quoteIdent(name: string): string {
  if (!name || /[\0"]/.test(name)) throw new Error(`invalid identifier '${name}'`);
  return `"${name}"`;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function formatStat(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  return value.toPrecision(4);
}

function formatCell(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : Number.isFinite(value) ? value.toFixed(4) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

function formatRow(columns: string[], row: Record<string, unknown>): string {
  return "  " + columns.map((column) => formatCell(row[column])).join(" | ");
}

export function formatColumnSketch(column: string, sketch: FrameColumnSketch, compact = false): string {
  const count = sketch.count ?? 0;
  const nulls = sketch.nulls ?? 0;
  const top = sketch.top?.length
    ? sketch.top.map((entry) => `${entry.value}:${entry.n}`).join(", ")
    : sketch.values?.join(", ");
  if (sketch.type === "number") {
    if (compact) {
      const range = `${sketch.min ?? "?"}..${sketch.max ?? "?"}`;
      const mean = sketch.mean === undefined ? "" : ` mean=${formatStat(sketch.mean)}`;
      return `${column}: number ${range}${mean}`;
    }
    const parts = [`${column}: number`, `count=${count}`, `nulls=${nulls}`];
    if (sketch.min !== undefined) parts.push(`min=${formatStat(sketch.min)}`);
    if (sketch.max !== undefined) parts.push(`max=${formatStat(sketch.max)}`);
    if (sketch.mean !== undefined) parts.push(`mean=${formatStat(sketch.mean)}`);
    if (sketch.p25 !== undefined) parts.push(`p25=${formatStat(sketch.p25)}`);
    if (sketch.p50 !== undefined) parts.push(`p50=${formatStat(sketch.p50)}`);
    if (sketch.p75 !== undefined) parts.push(`p75=${formatStat(sketch.p75)}`);
    return parts.join(" ");
  }
  if (compact) {
    if (sketch.type === "string" && top) return `${column}: string {${top}}`;
    return `${column}: ${sketch.type}`;
  }
  if (sketch.type === "string") {
    return `${column}: string count=${count} nulls=${nulls}${top ? ` top={${top}}` : ""}`;
  }
  if (sketch.type === "boolean") {
    return `${column}: boolean count=${count} nulls=${nulls}${top ? ` {${top}}` : ""}`;
  }
  return `${column}: ${sketch.type} count=${count} nulls=${nulls}`;
}

export function buildFrameSummary(columns: string[], rows: Record<string, unknown>[]): Record<string, FrameColumnSketch> {
  const result: Record<string, FrameColumnSketch> = {};
  for (const column of columns) {
    let type: FrameColumnSketch["type"] = "other";
    let nulls = 0;
    const numbers: number[] = [];
    const freq = new Map<string, number>();
    for (const row of rows) {
      const value = row[column];
      if (value == null) {
        nulls++;
        continue;
      }
      if (typeof value === "number") {
        if (type === "other") type = "number";
        if (type === "number" && Number.isFinite(value)) numbers.push(value);
      } else if (typeof value === "boolean") {
        if (type === "other") type = "boolean";
        if (type === "boolean") freq.set(value ? "true" : "false", (freq.get(value ? "true" : "false") ?? 0) + 1);
      } else {
        if (type === "other") type = "string";
        if (type === "string") {
          const text = String(value);
          freq.set(text, (freq.get(text) ?? 0) + 1);
        }
      }
    }
    const count = rows.length - nulls;
    const sketch: FrameColumnSketch = { type, count, nulls };
    if (type === "number" && numbers.length) {
      numbers.sort((a, b) => a - b);
      const sum = numbers.reduce((total, value) => total + value, 0);
      sketch.min = numbers[0];
      sketch.max = numbers[numbers.length - 1];
      sketch.mean = sum / numbers.length;
      sketch.p25 = quantile(numbers, 0.25);
      sketch.p50 = quantile(numbers, 0.5);
      sketch.p75 = quantile(numbers, 0.75);
    } else if (freq.size) {
      const top = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, TOP_VALUE_LIMIT)
        .map(([value, n]) => ({ value: value.length > 40 ? value.slice(0, 37) + "…" : value, n }));
      sketch.top = top;
      sketch.values = top.map((entry) => entry.value);
    }
    result[column] = sketch;
  }
  return result;
}

function extremaRows(
  columns: string[],
  rows: Record<string, unknown>[],
  summary: Record<string, FrameColumnSketch>,
): { label: string; row: Record<string, unknown> }[] {
  const numeric = columns.filter((column) => {
    const sketch = summary[column];
    return sketch?.type === "number" && sketch.min !== undefined && sketch.max !== undefined && sketch.min !== sketch.max;
  }).slice(0, SAMPLE_EXTREMA_COLUMNS);
  const out: { label: string; row: Record<string, unknown> }[] = [];
  for (const column of numeric) {
    const sketch = summary[column];
    const minRow = rows.find((row) => row[column] === sketch.min);
    let maxRow: Record<string, unknown> | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][column] === sketch.max) {
        maxRow = rows[i];
        break;
      }
    }
    if (minRow) out.push({ label: `${column} min`, row: minRow });
    if (maxRow) out.push({ label: `${column} max`, row: maxRow });
  }
  return out;
}

const DATE_COL_RE = /^(date|day|dt|as_of|asof|trade_date|tradedate|session_date|timestamp|ts)$/i;
const CLOSE_COL_RE = /^(close|adj_close|adjclose|adjusted_close|price|last|px|settle|settlement)$/i;
const SERIES_COL_RE = /^(symbol|ticker|underlying|name|series|asset)$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function pickNamedColumn(columns: string[], re: RegExp): string | null {
  return columns.find((c) => re.test(c)) ?? null;
}

function cellDate(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (ISO_DATE_RE.test(trimmed)) return trimmed.slice(0, 10);
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 1e11) {
    // epoch ms — uncommon in lake frames but cheap to accept
    return new Date(value).toISOString().slice(0, 10);
  }
  return null;
}

function cellNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export interface PeriodSeriesStats {
  series: string;
  start: number;
  end: number;
  totalReturnPct: number;
  dailyStdPct: number | null;
  maxClose: number;
  maxCloseDate: string;
  minClose: number;
  minCloseDate: string;
  sharpDropDate: string | null;
  points: number;
}

export interface PeriodStatsTable {
  seriesColumn: string | null;
  dateColumn: string;
  closeColumn: string;
  rows: PeriodSeriesStats[];
}

/**
 * Detect long-format OHLC / close panels (date + close [+ symbol/ticker]) and
 * roll them into the experiment's winning `stats_table` shape: one row per
 * series with period return, daily σ, extrema dates, and optional crash day.
 * Returns null for option chains and other non-time-series frames.
 */
export function buildPeriodStatsTable(
  columns: string[],
  rows: Record<string, unknown>[],
): PeriodStatsTable | null {
  if (rows.length < PERIOD_STATS_MIN_POINTS) return null;

  const dateColumn = pickNamedColumn(columns, DATE_COL_RE);
  const closeColumn = pickNamedColumn(columns, CLOSE_COL_RE);
  if (!dateColumn || !closeColumn || dateColumn === closeColumn) return null;

  const seriesColumn = pickNamedColumn(columns, SERIES_COL_RE);
  // Avoid mistaking option chains: expiration-like dates + strike/IV without a
  // close column already fail above; also require several distinct dates.
  const distinctDates = new Set<string>();
  for (const row of rows) {
    const d = cellDate(row[dateColumn]);
    if (d) distinctDates.add(d);
  }
  if (distinctDates.size < PERIOD_STATS_MIN_POINTS) return null;

  type Point = { date: string; close: number };
  const bySeries = new Map<string, Point[]>();
  for (const row of rows) {
    const date = cellDate(row[dateColumn]);
    const close = cellNumber(row[closeColumn]);
    if (!date || close == null) continue;
    const key = seriesColumn
      ? String(row[seriesColumn] ?? "").trim().toUpperCase() || "—"
      : "series";
    let list = bySeries.get(key);
    if (!list) {
      list = [];
      bySeries.set(key, list);
    }
    list.push({ date, close });
  }

  const stats: PeriodSeriesStats[] = [];
  for (const [series, points] of bySeries) {
    if (points.length < PERIOD_STATS_MIN_POINTS) continue;
    points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Collapse duplicate dates (keep last close of the day).
    const deduped: Point[] = [];
    for (const p of points) {
      const last = deduped[deduped.length - 1];
      if (last && last.date === p.date) last.close = p.close;
      else deduped.push({ ...p });
    }
    if (deduped.length < PERIOD_STATS_MIN_POINTS) continue;

    const start = deduped[0]!.close;
    const end = deduped[deduped.length - 1]!.close;
    if (!(start > 0)) continue;

    let maxClose = deduped[0]!.close;
    let maxCloseDate = deduped[0]!.date;
    let minClose = deduped[0]!.close;
    let minCloseDate = deduped[0]!.date;
    const dailyReturns: number[] = [];
    let sharpDropDate: string | null = null;
    let sharpDropPct = 0;
    for (let i = 0; i < deduped.length; i++) {
      const p = deduped[i]!;
      if (p.close > maxClose) {
        maxClose = p.close;
        maxCloseDate = p.date;
      }
      if (p.close < minClose) {
        minClose = p.close;
        minCloseDate = p.date;
      }
      if (i > 0) {
        const prev = deduped[i - 1]!.close;
        if (prev > 0) {
          const retPct = ((p.close - prev) / prev) * 100;
          dailyReturns.push(retPct);
          if (retPct <= PERIOD_STATS_SHARP_DROP_PCT && retPct < sharpDropPct) {
            sharpDropPct = retPct;
            sharpDropDate = p.date;
          }
        }
      }
    }

    stats.push({
      series,
      start,
      end,
      totalReturnPct: ((end - start) / start) * 100,
      dailyStdPct: stdDev(dailyReturns),
      maxClose,
      maxCloseDate,
      minClose,
      minCloseDate,
      sharpDropDate,
      points: deduped.length,
    });
  }

  if (!stats.length) return null;
  // Multi-ticker panels are the experiment win; single-series still helps.
  stats.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  return {
    seriesColumn,
    dateColumn,
    closeColumn,
    rows: stats.slice(0, PERIOD_STATS_MAX_SERIES),
  };
}

function formatPeriodPct(value: number): string {
  return value.toFixed(2);
}

/** Markdown-ish pipe table matching the notebook `stats_table` encoding. */
export function formatPeriodStatsTable(table: PeriodStatsTable): string[] {
  const idHeader = table.seriesColumn ?? "series";
  const lines = [
    `Period performance (by ${idHeader}; close=${table.closeColumn}, date=${table.dateColumn}):`,
    `${idHeader} | start | end | total_return_pct | daily_std_pct | max_date | min_date | sharp_drop_date`,
    "-------|-------|-----|------------------|---------------|----------|----------|----------------",
  ];
  for (const row of table.rows) {
    lines.push(
      `${row.series} | ${formatStat(row.start)} | ${formatStat(row.end)} | `
        + `${formatPeriodPct(row.totalReturnPct)} | `
        + `${row.dailyStdPct == null ? "—" : formatPeriodPct(row.dailyStdPct)} | `
        + `${row.maxCloseDate} | ${row.minCloseDate} | ${row.sharpDropDate ?? "—"}`,
    );
  }
  return lines;
}

export function summarizeResult(result: ResultView, notes: string[] = []): string {
  const lines = [`Columns: ${result.columns.join(", ")}`, `Row count: ${result.row_count}`, ...notes];
  if (result.truncated) lines.push("Truncated: true");
  if (result.rows.length) {
    const summary = buildFrameSummary(result.columns, result.rows);
    lines.push("---", "Stats:");
    for (const column of result.columns) {
      const sketch = summary[column] ?? { type: "other" as const, count: 0, nulls: result.rows.length };
      lines.push("  " + formatColumnSketch(column, sketch));
    }
    // text-vs-image: period stats tables beat chart images and match/beat raw
    // tool summaries for multi-name close panels — inject when detectable.
    const period = buildPeriodStatsTable(result.columns, result.rows);
    if (period) {
      lines.push("---", ...formatPeriodStatsTable(period));
    }
    lines.push("---", "Sample:");
    const headN = Math.min(SAMPLE_HEAD_ROWS, result.rows.length);
    lines.push(`head (${headN}):`);
    for (const row of result.rows.slice(0, headN)) lines.push(formatRow(result.columns, row));
    if (result.rows.length > SAMPLE_HEAD_ROWS) {
      const tailN = Math.min(SAMPLE_TAIL_ROWS, result.rows.length - SAMPLE_HEAD_ROWS);
      const tail = result.rows.slice(-tailN);
      lines.push(`tail (${tail.length}):`);
      for (const row of tail) lines.push(formatRow(result.columns, row));
    }
    const extrema = extremaRows(result.columns, result.rows, summary);
    if (extrema.length) {
      lines.push("extrema:");
      for (const item of extrema) {
        lines.push(`  ${item.label}:`);
        lines.push(formatRow(result.columns, item.row));
      }
    }
  }
  return lines.join("\n").slice(0, MAX_TOOL_SUMMARY_CHARS);
}

function tokenize(expression: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  while (i < expression.length) {
    const char = expression[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === "'") {
      let value = "";
      i++;
      let closed = false;
      while (i < expression.length) {
        if (expression[i] === "'") {
          if (expression[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        value += expression[i++];
      }
      if (!closed) throw new Error("unterminated string literal");
      tokens.push({ type: "string", value });
      continue;
    }
    const number = expression.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      i += number[0].length;
      continue;
    }
    const identifier = expression.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier[0] });
      i += identifier[0].length;
      continue;
    }
    const two = expression.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      tokens.push({ type: "operator", value: two });
      i += 2;
      continue;
    }
    if (["<", ">", "!", "-"].includes(char)) {
      tokens.push({ type: "operator", value: char });
      i++;
      continue;
    }
    if (["(", ")", ","].includes(char)) {
      tokens.push({ type: "punctuation", value: char });
      i++;
      continue;
    }
    throw new Error(`unsupported expression token '${char}'`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class ExprParser {
  private index = 0;
  constructor(private readonly tokens: ExprToken[], private readonly columns: Set<string>) {}

  parse(): ExprNode {
    const node = this.parseOr();
    if (this.peek().type !== "eof") throw new Error(`unexpected token '${this.peek().value}'`);
    return node;
  }

  private peek(): ExprToken { return this.tokens[this.index]; }
  private take(): ExprToken { return this.tokens[this.index++]; }
  private accept(value: string): boolean {
    if (this.peek().value !== value) return false;
    this.index++;
    return true;
  }
  private parseOr(): ExprNode {
    let node = this.parseAnd();
    while (this.accept("||")) node = { type: "binary", op: "||", left: node, right: this.parseAnd() };
    return node;
  }
  private parseAnd(): ExprNode {
    let node = this.parseEquality();
    while (this.accept("&&")) node = { type: "binary", op: "&&", left: node, right: this.parseEquality() };
    return node;
  }
  private parseEquality(): ExprNode {
    let node = this.parseComparison();
    while (["==", "!="].includes(this.peek().value)) {
      const op = this.take().value;
      node = { type: "binary", op, left: node, right: this.parseComparison() };
    }
    return node;
  }
  private parseComparison(): ExprNode {
    let node = this.parseUnary();
    while (["<", "<=", ">", ">="].includes(this.peek().value)) {
      const op = this.take().value;
      node = { type: "binary", op, left: node, right: this.parseUnary() };
    }
    return node;
  }
  private parseUnary(): ExprNode {
    if (this.accept("!")) return { type: "unary", op: "!", value: this.parseUnary() };
    if (this.accept("-")) return { type: "unary", op: "-", value: this.parseUnary() };
    return this.parsePrimary();
  }
  private parsePrimary(): ExprNode {
    const token = this.take();
    if (token.type === "number") return { type: "literal", value: Number(token.value) };
    if (token.type === "string") return { type: "literal", value: token.value };
    if (token.value === "(") {
      const node = this.parseOr();
      if (!this.accept(")")) throw new Error("missing closing parenthesis");
      return node;
    }
    if (token.type !== "identifier") throw new Error(`unexpected token '${token.value}'`);
    if (token.value === "true" || token.value === "false") return { type: "literal", value: token.value === "true" };
    if (token.value === "null") return { type: "literal", value: null };
    if (this.accept("(")) {
      if (!["abs", "min", "max", "round"].includes(token.value)) throw new Error(`unknown function '${token.value}'`);
      const args: ExprNode[] = [];
      if (!this.accept(")")) {
        do { args.push(this.parseOr()); } while (this.accept(","));
        if (!this.accept(")")) throw new Error("missing closing parenthesis");
      }
      return { type: "call", name: token.value, args };
    }
    if (!this.columns.has(token.value)) throw new Error(`unknown column '${token.value}'`);
    return { type: "column", name: token.value };
  }
}

function compileExpr(node: ExprNode, column: ColumnCompile = JSON_COLUMN): SqlExpr {
  if (node.type === "literal") {
    const value = node.value;
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("unsupported literal");
    }
    return { sql: "?", values: [value] };
  }
  if (node.type === "column") return column(node.name);
  if (node.type === "unary") {
    const value = compileExpr(node.value, column);
    return { sql: node.op === "!" ? `(NOT (${value.sql}))` : `(-(${value.sql}))`, values: value.values };
  }
  if (node.type === "call") {
    if (!node.args.length) throw new Error(`${node.name} requires an argument`);
    const args = node.args.map((arg) => compileExpr(arg, column));
    return { sql: `${node.name}(${args.map((arg) => arg.sql).join(", ")})`, values: args.flatMap((arg) => arg.values) };
  }
  const left = compileExpr(node.left, column);
  const right = compileExpr(node.right, column);
  const operator = node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op === "==" ? "IS" : node.op === "!=" ? "IS NOT" : node.op;
  return { sql: `((${left.sql}) ${operator} (${right.sql}))`, values: [...left.values, ...right.values] };
}

function parseWhere(expression: string | undefined, columns: Set<string>): SqlExpr {
  return expression?.trim()
    ? compileExpr(new ExprParser(tokenize(expression), columns).parse())
    : { sql: "1", values: [] };
}

function parseSort(expression: string | undefined, columns: Set<string>, column: ColumnCompile): SqlExpr | null {
  return expression?.trim()
    ? compileExpr(new ExprParser(tokenize(expression), columns).parse(), column)
    : null;
}

function compileReduction(
  columnSet: Set<string>,
  frameName: string,
  where: SqlExpr,
  args: FrameQueryArgs,
  groupBy: string[],
  aggregations: FrameAggregation[],
  limit: number,
): CompiledFrameQuery {
  for (const column of groupBy) {
    if (!columnSet.has(column)) throw new Error(`unknown column '${column}'`);
  }

  const used = new Set<string>(groupBy);
  const aggSelects: { sql: string; values: SqlValue[]; alias: string }[] = [];
  for (const agg of aggregations) {
    const star = agg.fn === "count" && (!agg.column || agg.column === "*");
    if (!star && !agg.column) throw new Error(`${agg.fn} requires a column`);
    if (!star && agg.column && !columnSet.has(agg.column)) throw new Error(`unknown column '${agg.column}'`);
    const alias = agg.as?.trim() || (star ? "count" : `${agg.fn}_${agg.column}`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`invalid aggregation alias '${alias}'`);
    if (used.has(alias)) throw new Error(`duplicate result column '${alias}'`);
    used.add(alias);
    if (star) {
      aggSelects.push({ sql: `COUNT(*) AS ${quoteIdent(alias)}`, values: [], alias });
    } else if (agg.fn === "count") {
      aggSelects.push({
        sql: `COUNT(json_extract(row_json, ?)) AS ${quoteIdent(alias)}`,
        values: [jsonPath(agg.column!)],
        alias,
      });
    } else {
      aggSelects.push({
        sql: `${AGG_SQL[agg.fn]}(CAST(json_extract(row_json, ?) AS REAL)) AS ${quoteIdent(alias)}`,
        values: [jsonPath(agg.column!)],
        alias,
      });
    }
  }

  const columns = [...groupBy, ...aggSelects.map((agg) => agg.alias)];
  const innerSelects: string[] = [];
  const innerValues: SqlValue[] = [];
  for (const column of groupBy) {
    innerSelects.push(`json_extract(row_json, ?) AS ${quoteIdent(column)}`);
    innerValues.push(jsonPath(column));
  }
  for (const agg of aggSelects) {
    innerSelects.push(agg.sql);
    innerValues.push(...agg.values);
  }

  const groupSql = groupBy.length
    ? ` GROUP BY ${groupBy.map(() => "json_extract(row_json, ?)").join(", ")}`
    : "";
  const groupValues = groupBy.map(jsonPath);
  const sort = parseSort(args.sort, new Set(columns), ALIAS_COLUMN);
  const objectParts = columns.map((column) => `?, ${quoteIdent(column)}`);
  const sql = `SELECT json_object(${objectParts.join(", ")}) AS row_json FROM (SELECT ${innerSelects.join(", ")} FROM frame_rows WHERE frame_name = ? AND (${where.sql})${groupSql}${sort ? ` ORDER BY ${sort.sql}` : ""} LIMIT ?) AS grouped`;
  const values: SqlValue[] = [
    ...columns,
    ...innerValues,
    frameName,
    ...where.values,
    ...groupValues,
    ...(sort?.values ?? []),
    limit,
  ];
  return { sql, values, columns };
}

export function compileFrameQuery(frameColumns: string[], frameName: string, args: FrameQueryArgs): CompiledFrameQuery {
  const columnSet = new Set(frameColumns);
  const where = parseWhere(args.where, columnSet);
  const limit = Math.max(0, Math.min(Math.round(args.limit ?? FRAME_QUERY_LIMIT), FRAME_QUERY_LIMIT));
  const aggregations = args.aggregations ?? [];
  const groupBy = args.group_by ?? [];
  if (groupBy.length && !aggregations.length) {
    throw new Error("group_by requires aggregations (avg, sum, count, min, or max)");
  }
  if (aggregations.length) {
    return compileReduction(columnSet, frameName, where, args, groupBy, aggregations, limit);
  }

  const sort = parseSort(args.sort, columnSet, JSON_COLUMN);
  const requested = args.project?.filter((column) => columnSet.has(column));
  const columns = requested?.length ? frameColumns.filter((column) => requested.includes(column)) : frameColumns;
  const projectionValues: SqlValue[] = [];
  const projection = requested?.length
    ? `json_object(${columns.map((column) => {
      projectionValues.push(column, jsonPath(column));
      return "?, json_extract(row_json, ?)";
    }).join(", ")})`
    : "row_json";
  const sql = `SELECT ${projection} AS row_json FROM frame_rows WHERE frame_name = ? AND (${where.sql})${sort ? ` ORDER BY ${sort.sql}, row_index ASC` : " ORDER BY row_index ASC"} LIMIT ?`;
  const values: SqlValue[] = [...projectionValues, frameName, ...where.values, ...(sort?.values ?? []), limit];
  return { sql, values, columns };
}
