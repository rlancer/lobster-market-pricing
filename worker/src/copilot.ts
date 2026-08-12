import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { COPILOT_TOOL_INPUT_SCHEMAS, FRAME_QUERY_LIMIT, createCopilotModel } from "./copilot-contract";

export interface CopilotEnv extends Cloudflare.Env {}

export interface LakeTable {
  name: string;
  row_count: number | null;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
  limit?: number;
  error?: string;
}

export interface NewsResult {
  symbol: string;
  items: { title: string; link: string }[];
  error?: string;
}

export interface SearchResult {
  query: string;
  results: { title: string; link: string }[];
  error?: string;
}

export interface CalendarResult {
  items: { date: string; time?: string; title: string }[];
  error?: string;
}

export interface ChartSpec {
  title?: string;
  kind: "line" | "area" | "scatter" | "bar";
  x: string;
  y: string;
  series?: string;
  xLabel?: string;
  yLabel?: string;
}

export interface FrameMetadata {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
}

interface FrameColumnSketch {
  type: "number" | "string" | "boolean" | "other";
  min?: number;
  max?: number;
  values?: string[];
}

interface StoredFrame extends FrameMetadata {
  summary: Record<string, FrameColumnSketch>;
}

interface Capture {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
}

interface ToolOutput {
  ok: boolean;
  error?: string | null;
  issues?: string[];
  summary: string;
  // Bounded presentation data carried directly on the tool output parts — the
  // frontend reads SQL/result/chart/frames straight from the standard AI SDK
  // tool-output parts instead of a bespoke bundle.
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  frames?: FrameMetadata[];
}

interface CopilotMetadata {
  model: string;
  createdAt: number;
}

type CopilotData = Record<string, unknown> & {
  status: { status: string };
};

type CopilotMessage = UIMessage<CopilotMetadata, CopilotData>;
type SqlValue = string | number | boolean | null;

const QUESTION_MAX_CHARS = 4_000;
const HISTORY_MESSAGES_MAX = 16;
const HISTORY_MESSAGE_MAX_CHARS = 6_000;
const HISTORY_CHARS_DEFAULT = 48_000;
const OUTPUT_TOKENS_DEFAULT = 8_192;
const OUTPUT_TOKENS_MAX = 16_384;
const AGENT_ITERATIONS_MAX = 10;
const TOOL_ROUND_TOKENS_MAX = 2_048;
const FINAL_TOKEN_RESERVE = 1_024;
const FRAME_TTL_MS = 15 * 60_000;
const MAX_FRAMES = 8;
const MAX_FRAME_ROWS = 100_000;
const RESULT_PERSIST_MAX_ROWS = 200;
const MAX_TOOL_SUMMARY_CHARS = 12_000;
const CONVERSATION_RETENTION_DAYS = 30;

export const TOOL_LABELS: Record<string, string> = {
  run_query: "SQL query",
  check_schema: "Check schema",
  list_frames: "List frames",
  filter_frame: "Filter frame",
  refresh_frame: "Refresh frame",
  render_chart: "Render chart",
  get_news: "News",
  eco_calendar: "Eco calendar",
  web_search: "Web search",
};

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : fallback;
}

function schemaToPrompt(tables: LakeTable[]): string {
  return tables.map((table) => {
    const columns = table.columns.map((column) => `    ${column.name} ${column.type}`).join("\n");
    const samples = table.sample?.length
      ? `\n  sample rows:\n${table.sample.map((row) => `    ${JSON.stringify(row)}`).join("\n")}`
      : "";
    const distinct: string[] = [];
    for (const column of table.columns) {
      const values = [...new Set((table.sample ?? []).map((row) => row[column.name]).filter((value) => value != null))];
      if (values.length > 0 && values.length <= 6) {
        distinct.push(`    ${column.name} in {${values.map((value) => JSON.stringify(value)).join(", ")}}`);
      }
    }
    const enums = distinct.length ? `\n  low-cardinality values:\n${distinct.join("\n")}` : "";
    const rows = table.row_count == null ? "" : `\n  row_count: ${table.row_count.toLocaleString("en-US")}`;
    return `TABLE options.${table.name}\n  columns:\n${columns}${samples}${enums}${rows}`;
  }).join("\n\n");
}

function systemPrompt(schema: string): string {
  return [
    "You are a senior quant developer writing DataFusion SQL (R2 SQL) against an options market Iceberg lake.",
    "",
    "Schema:",
    schema,
    "",
    "Rules:",
    "- To answer a market-data question, ALWAYS write a read-only query and execute it with run_query. Never return only SQL.",
    "- ALWAYS end the turn with a concise plain-English answer grounded in your results. A query, table, chart, or frame alone is never a complete turn — even for a chart request, close with a 1-3 sentence takeaway.",
    "- Use only table and column names in the schema. Never invent identifiers. check_schema and run_query validate them.",
    "- End the top-level query with LIMIT. Prefer explicit columns. No OFFSET, CROSS JOIN, or named WINDOW clauses. WHERE comes before QUALIFY.",
    "- implied_vol is decimal (0.25 = 25%). spot_price is the spot column. expiration is TEXT; DTE is CAST(expiration AS DATE) - CURRENT_DATE.",
    "- Avoid expensive unfiltered joins, high-cardinality DISTINCT, ARRAY_AGG/STRING_AGG, and large window partitions. Filter before joining; use approx_* aggregates where possible.",
    "- Stop retrying the same failing SQL: fix it at most twice from the error, then simplify to a smaller, looser query. Do not call check_schema repeatedly on the same SQL. If a query returns no rows, say so and suggest a looser criterion.",
    "- For why-is-it-moving questions, compare implied vs realized vol, check upcoming options.earnings, then use get_news or web_search and cite links.",
    "- If the user asks about upcoming Fed meetings, macro reports, or broad event risk, MUST call eco_calendar even if options.econ_calendar is also queried; the tool merges the freshest calendar sources.",
    "- Do not explain SQL mechanics. Mention specific symbols, sectors, dates, and numbers where useful.",
    "",
    "Cached frames:",
    "- For one-symbol chains, smiles, surfaces, or OI profiles, call run_query once with save_as and include dte and spot_price. Use list_frames and filter_frame for follow-ups rather than re-querying.",
    "- Frames expire after 15 minutes; refresh_frame re-runs their source SQL.",
    "",
    "Charting:",
    "- When the user asks for a chart, call render_chart after producing chartable data. For a vol surface use x=strike, y=implied_vol, series=expiration; use exact result column names.",
  ].join("\n");
}

interface ValidatedIssue {
  severity: "error" | "warning";
  message: string;
}

const SQL_ALIAS_KEYWORDS: Record<string, true> = {
  select: true, from: true, where: true, join: true, left: true, right: true,
  full: true, inner: true, outer: true, cross: true, on: true, group: true,
  order: true, limit: true, qualify: true, having: true, union: true, as: true,
  and: true, or: true, when: true, then: true, else: true, end: true, case: true,
  with: true, by: true, asc: true, desc: true, nulls: true, first: true,
  last: true, over: true, partition: true, distinct: true, all: true,
};

export function validateSqlSchema(sql: string, tables: LakeTable[]): ValidatedIssue[] {
  const issues: ValidatedIssue[] = [];
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) issues.push({ severity: "error", message: "Only SELECT or WITH queries are allowed." });
  if (/;/.test(trimmed)) issues.push({ severity: "error", message: "Multiple SQL statements are not allowed." });
  if (/\b(insert|update|delete|drop|alter|create|truncate|copy|call|merge)\b/i.test(trimmed)) issues.push({ severity: "error", message: "Mutating SQL is not allowed." });
  if (!/\blimit\s+\d+\b/i.test(trimmed)) issues.push({ severity: "warning", message: "The query should end with an explicit LIMIT." });
  if (/\boffset\b/i.test(trimmed)) issues.push({ severity: "error", message: "OFFSET is not supported." });
  if (/\bcross\s+join\b/i.test(trimmed)) issues.push({ severity: "error", message: "CROSS JOIN is not allowed." });
  if (/\bwindow\s+[A-Za-z_]/i.test(trimmed)) issues.push({ severity: "error", message: "Named WINDOW clauses are not supported." });

  const tableMap = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  const references = [...trimmed.matchAll(/\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)\b/gi)];
  for (const match of references) {
    const name = match[1].toLowerCase();
    if (!tableMap.has(name) && !/^\w+$/.test(name)) continue;
    if (!tableMap.has(name)) issues.push({ severity: "error", message: `Unknown table options.${match[1]}.` });
  }

  const aliases = new Map<string, LakeTable>();
  const tablePattern = /\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of trimmed.matchAll(tablePattern)) {
    const table = tableMap.get(match[1].toLowerCase());
    if (!table) continue;
    aliases.set(match[1].toLowerCase(), table);
    if (match[2] && !SQL_ALIAS_KEYWORDS[match[2].toLowerCase()]) aliases.set(match[2].toLowerCase(), table);
  }
  for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const qualifier = match[1].toLowerCase();
    if (qualifier === "options") continue;
    const table = aliases.get(qualifier);
    if (!table) continue;
    const column = match[2].toLowerCase();
    if (!table.columns.some((candidate) => candidate.name.toLowerCase() === column)) {
      issues.push({ severity: "error", message: `Unknown column ${match[1]}.${match[2]} on options.${table.name}.` });
    }
  }
  return issues;
}

function summarizeResult(result: QueryResult): string {
  const lines = [`Columns: ${result.columns.join(", ")}`, `Row count: ${result.row_count}`];
  if (result.rows.length) {
    lines.push("---", "Rows (pipe-separated):");
    for (const row of result.rows.slice(0, 30)) {
      lines.push("  " + result.columns.map((column) => {
        const value = row[column];
        if (value == null) return "null";
        if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
        const text = String(value);
        return text.length > 120 ? text.slice(0, 117) + "…" : text;
      }).join(" | "));
    }
    if (result.rows.length > 30) lines.push(`  … (showing 30 of ${result.row_count} rows)`);
  }
  return lines.join("\n").slice(0, MAX_TOOL_SUMMARY_CHARS);
}

function buildFrameSummary(columns: string[], rows: Record<string, unknown>[]): Record<string, FrameColumnSketch> {
  const result: Record<string, FrameColumnSketch> = {};
  const sampled = rows.slice(0, 20_000);
  for (const column of columns) {
    let type: FrameColumnSketch["type"] = "other";
    let min: number | undefined;
    let max: number | undefined;
    const values = new Set<string>();
    for (const row of sampled) {
      const value = row[column];
      if (value == null) continue;
      if (typeof value === "number") {
        if (type === "other") type = "number";
        min = min === undefined ? value : Math.min(min, value);
        max = max === undefined ? value : Math.max(max, value);
      } else if (typeof value === "boolean") {
        if (type === "other") type = "boolean";
      } else {
        if (type === "other") type = "string";
        if (values.size < 12) values.add(String(value));
      }
    }
    result[column] = { type, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }), ...(values.size ? { values: [...values].sort() } : {}) };
  }
  return result;
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

interface SqlExpr {
  sql: string;
  values: SqlValue[];
}

function jsonPath(column: string): string {
  return `$.${JSON.stringify(column)}`;
}

function compileExpr(node: ExprNode): SqlExpr {
  if (node.type === "literal") {
    const value = node.value;
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("unsupported literal");
    }
    return { sql: "?", values: [value] };
  }
  if (node.type === "column") return { sql: "json_extract(row_json, ?)", values: [jsonPath(node.name)] };
  if (node.type === "unary") {
    const value = compileExpr(node.value);
    return { sql: node.op === "!" ? `(NOT (${value.sql}))` : `(-(${value.sql}))`, values: value.values };
  }
  if (node.type === "call") {
    if (!node.args.length) throw new Error(`${node.name} requires an argument`);
    const args = node.args.map(compileExpr);
    return { sql: `${node.name}(${args.map((arg) => arg.sql).join(", ")})`, values: args.flatMap((arg) => arg.values) };
  }
  const left = compileExpr(node.left);
  const right = compileExpr(node.right);
  const operator = node.op === "&&" ? "AND" : node.op === "||" ? "OR" : node.op === "==" ? "IS" : node.op === "!=" ? "IS NOT" : node.op;
  return { sql: `((${left.sql}) ${operator} (${right.sql}))`, values: [...left.values, ...right.values] };
}

function boundedMessages(messages: UIMessage[], historyCharsMax: number): ModelMessage[] {
  const candidates = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim(),
    }))
    .filter((message) => message.content)
    .slice(-HISTORY_MESSAGES_MAX);
  const latest = candidates[candidates.length - 1];
  if (!latest || latest.role !== "user") throw new Error("A user question is required.");
  if (latest.content.length > QUESTION_MAX_CHARS) throw new Error(`question exceeds ${QUESTION_MAX_CHARS} characters`);

  const selected: typeof candidates = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i];
    const content = message.content.slice(0, HISTORY_MESSAGE_MAX_CHARS);
    if (chars + content.length > historyCharsMax && selected.length > 0) break;
    selected.unshift({ ...message, content });
    chars += content.length;
  }
  return selected.map((message) => ({ role: message.role, content: message.content }));
}

function boundedResult(result: QueryResult | null): QueryResult | null {
  return result ? { ...result, rows: result.rows.slice(0, RESULT_PERSIST_MAX_ROWS) } : null;
}

function normalizeReasoningEffort(value: string): "xhigh" | "high" | "medium" | "low" | "minimal" | "none" {
  return ["xhigh", "high", "medium", "low", "minimal", "none"].includes(value) ? value as "xhigh" | "high" | "medium" | "low" | "minimal" | "none" : "high";
}

/**
 * Shared AIChatAgent implementation. The concrete Worker class supplies the
 * existing lake/news/search/calendar business helpers without HTTP self-calls.
 */
export abstract class CopilotAgentBase<E extends CopilotEnv> extends AIChatAgent<E> {
  override messageConcurrency = "queue" as const;
  override maxPersistedMessages = 100;
  override chatRecovery = {
    maxAttempts: 3,
    stableTimeoutMs: 15_000,
    maxAgeMs: 10 * 60_000,
    noProgressLimit: 2,
    terminalMessage: "The assistant was interrupted and could not recover this turn.",
  };
  override chatStreamStallTimeoutMs = 120_000;

  protected abstract loadSchema(): Promise<LakeTable[]>;
  protected abstract executeLakeQuery(sql: string, limit: number): Promise<QueryResult>;
  protected abstract fetchNews(symbol: string, limit: number): Promise<NewsResult>;
  protected abstract searchWeb(query: string, limit: number): Promise<SearchResult>;
  protected abstract fetchEconomicCalendar(days: number): Promise<CalendarResult>;

  private ensureCopilotSchema(): void {
    this.sql`CREATE TABLE IF NOT EXISTS frames (
      name TEXT PRIMARY KEY,
      columns_json TEXT NOT NULL,
      source_sql TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS frame_rows (
      frame_name TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY(frame_name, row_index)
    ) WITHOUT ROWID`;
    this.sql`CREATE INDEX IF NOT EXISTS frame_rows_name_idx ON frame_rows(frame_name)`;
    this.sql`CREATE TABLE IF NOT EXISTS copilot_turn_budget (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      turn_id TEXT NOT NULL,
      used_output_tokens INTEGER NOT NULL,
      total_output_tokens INTEGER NOT NULL,
      successful_query INTEGER NOT NULL,
      capture_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
  }

  private dynamicSql<T>(query: string, values: SqlValue[]): T[] {
    const parts = query.split("?");
    if (parts.length !== values.length + 1) throw new Error("internal SQL parameter mismatch");
    const strings = parts as unknown as TemplateStringsArray;
    Object.defineProperty(strings, "raw", { value: [...parts] });
    return this.sql<T>(strings, ...values);
  }

  private deleteFrame(name: string): void {
    this.sql`DELETE FROM frame_rows WHERE frame_name = ${name}`;
    this.sql`DELETE FROM frames WHERE name = ${name}`;
  }

  private cleanupRetention(): void {
    const cutoff = Date.now() - FRAME_TTL_MS;
    const expired = this.sql<{ name: string }>`SELECT name FROM frames WHERE fetched_at < ${cutoff}`;
    for (const frame of expired) this.sql`DELETE FROM frame_rows WHERE frame_name = ${frame.name}`;
    this.sql`DELETE FROM cf_ai_chat_agent_messages WHERE created_at < datetime('now', ${`-${CONVERSATION_RETENTION_DAYS} days`})`;
  }

  private getFrame(name: string): StoredFrame | null {
    this.cleanupRetention();
    const row = this.sql<{ name: string; columns_json: string; source_sql: string; fetched_at: number; row_count: number; summary_json: string }>`
      SELECT name, columns_json, source_sql, fetched_at, row_count, summary_json
      FROM frames WHERE name = ${name} LIMIT 1
    `[0];
    if (!row) return null;
    return {
      name: row.name,
      columns: JSON.parse(row.columns_json) as string[],
      row_count: row.row_count,
      sql: row.source_sql,
      fetched_at: row.fetched_at,
      summary: JSON.parse(row.summary_json) as Record<string, FrameColumnSketch>,
    };
  }

  private saveFrame(name: string, columns: string[], rowsIn: Record<string, unknown>[], sql: string, fetchedAt = Date.now()): void {
    if (!rowsIn.length) return;
    const rows = rowsIn.slice(0, MAX_FRAME_ROWS);
    this.deleteFrame(name);
    this.sql`
      INSERT INTO frames (name, columns_json, source_sql, fetched_at, row_count, summary_json)
      VALUES (${name}, ${JSON.stringify(columns)}, ${sql}, ${fetchedAt}, ${rows.length}, ${JSON.stringify(buildFrameSummary(columns, rows))})
    `;
    for (let offset = 0; offset < rows.length; offset += 30) {
      const batch = rows.slice(offset, offset + 30);
      const placeholders = batch.map(() => "(?, ?, ?)").join(", ");
      const values = batch.flatMap((row, index): SqlValue[] => [name, offset + index, JSON.stringify(row)]);
      this.dynamicSql(`INSERT INTO frame_rows (frame_name, row_index, row_json) VALUES ${placeholders}`, values);
    }
    const overflow = this.sql<{ name: string }>`SELECT name FROM frames ORDER BY fetched_at DESC, name ASC LIMIT -1 OFFSET ${MAX_FRAMES}`;
    for (const frame of overflow) this.deleteFrame(frame.name);
  }

  @callable()
  async getFrameMetadata(): Promise<FrameMetadata[]> {
    this.ensureCopilotSchema();
    return this.frameMetadata();
  }

  private frameMetadata(): FrameMetadata[] {
    this.cleanupRetention();
    return this.sql<{ name: string; columns_json: string; row_count: number; source_sql: string; fetched_at: number }>`
      SELECT name, columns_json, row_count, source_sql, fetched_at
      FROM frames ORDER BY fetched_at DESC, name ASC
    `.map((row) => ({
      name: row.name,
      columns: JSON.parse(row.columns_json) as string[],
      row_count: row.row_count,
      sql: row.source_sql,
      fetched_at: row.fetched_at,
    }));
  }

  private frameCatalog(): string {
    const frames = this.sql<{ name: string; columns_json: string; row_count: number; fetched_at: number; summary_json: string }>`
      SELECT name, columns_json, row_count, fetched_at, summary_json FROM frames ORDER BY fetched_at DESC
    `;
    if (!frames.length) return "No cached frames in this chat yet.";
    return frames.map((frame) => {
      const columns = JSON.parse(frame.columns_json) as string[];
      const summary = JSON.parse(frame.summary_json) as Record<string, FrameColumnSketch>;
      const age = Math.max(0, Math.round((Date.now() - frame.fetched_at) / 60_000));
      const columnSummary = columns.map((column) => {
        const sketch = summary[column];
        if (!sketch) return column;
        if (sketch.type === "number") return `${column}: number ${sketch.min ?? "?"}..${sketch.max ?? "?"}`;
        if (sketch.type === "string" && sketch.values?.length) return `${column}: string {${sketch.values.join(", ")}}`;
        return `${column}: ${sketch.type}`;
      }).join(", ");
      return `- '${frame.name}': ${frame.row_count} rows × ${columns.length} cols, age ${age < 1 ? "<1" : age} min — ${columnSummary}`;
    }).join("\n").slice(0, MAX_TOOL_SUMMARY_CHARS);
  }

  private filterFrame(frame: StoredFrame, args: { where?: string; sort?: string; limit?: number; project?: string[] }): QueryResult {
    const columnSet = new Set(frame.columns);
    const where = args.where?.trim()
      ? compileExpr(new ExprParser(tokenize(args.where), columnSet).parse())
      : { sql: "1", values: [] as SqlValue[] };
    const sort = args.sort?.trim()
      ? compileExpr(new ExprParser(tokenize(args.sort), columnSet).parse())
      : null;
    const requested = args.project?.filter((column) => columnSet.has(column));
    const columns = requested?.length ? frame.columns.filter((column) => requested.includes(column)) : frame.columns;
    const projectionValues: SqlValue[] = [];
    const projection = requested?.length
      ? `json_object(${columns.map((column) => {
        projectionValues.push(column, jsonPath(column));
        return "?, json_extract(row_json, ?)";
      }).join(", ")})`
      : "row_json";
    const limit = Math.max(0, Math.min(Math.round(args.limit ?? FRAME_QUERY_LIMIT), FRAME_QUERY_LIMIT));
    const query = `SELECT ${projection} AS row_json FROM frame_rows WHERE frame_name = ? AND (${where.sql})${sort ? ` ORDER BY ${sort.sql}, row_index ASC` : " ORDER BY row_index ASC"} LIMIT ?`;
    const values: SqlValue[] = [...projectionValues, frame.name, ...where.values, ...(sort?.values ?? []), limit];
    const rows = this.dynamicSql<{ row_json: string }>(query, values).map((row) => JSON.parse(row.row_json) as Record<string, unknown>);
    return { columns, rows, row_count: rows.length, truncated: false, limit: rows.length };
  }

  private resetTurnBudget(turnId: string, total: number): Capture {
    const capture: Capture = { sql: null, result: null, chart: null };
    this.sql`
      INSERT OR REPLACE INTO copilot_turn_budget
        (singleton, turn_id, used_output_tokens, total_output_tokens, successful_query, capture_json, updated_at)
      VALUES (1, ${turnId}, 0, ${total}, 0, ${JSON.stringify(capture)}, ${Date.now()})
    `;
    return capture;
  }

  private readTurnBudget(): { turn_id: string; used_output_tokens: number; total_output_tokens: number; successful_query: number; capture_json: string } {
    const row = this.sql<{ turn_id: string; used_output_tokens: number; total_output_tokens: number; successful_query: number; capture_json: string }>`
      SELECT turn_id, used_output_tokens, total_output_tokens, successful_query, capture_json
      FROM copilot_turn_budget WHERE singleton = 1
    `[0];
    if (!row) throw new Error("Copilot turn budget is unavailable.");
    return row;
  }

  private writeTurnState(usedOutputTokens: number, successfulQuery: boolean, capture: Capture): void {
    this.sql`
      UPDATE copilot_turn_budget SET
        used_output_tokens = ${usedOutputTokens},
        successful_query = ${successfulQuery ? 1 : 0},
        capture_json = ${JSON.stringify(capture)},
        updated_at = ${Date.now()}
      WHERE singleton = 1
    `;
  }

  private output(ok: boolean, summary: string, extra: Pick<ToolOutput, "error" | "issues" | "sql" | "result" | "chart" | "frames"> = {}): ToolOutput {
    return {
      ok,
      summary: summary.slice(0, MAX_TOOL_SUMMARY_CHARS),
      error: extra.error,
      issues: extra.issues,
      ...(extra.sql !== undefined ? { sql: extra.sql } : {}),
      ...(extra.result !== undefined ? { result: boundedResult(extra.result) } : {}),
      ...(extra.chart !== undefined ? { chart: extra.chart } : {}),
      ...(extra.frames !== undefined ? { frames: extra.frames.slice(0, MAX_FRAMES) } : {}),
    };
  }

  private async safeTool(label: string, capture: Capture, operation: () => Promise<ToolOutput> | ToolOutput): Promise<ToolOutput> {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.output(false, `${label} failed: ${message}`, { error: message });
    }
  }

  private createTools(tables: LakeTable[], capture: Capture, status: (value: string) => void, turn: { used: number; successfulQuery: boolean }) {
    const persist = () => this.writeTurnState(turn.used, turn.successfulQuery, capture);
    return {
      run_query: tool({
        description: "Execute one read-only DataFusion SQL SELECT/WITH query against the options Iceberg lake. SQL is validated against the real schema first. Pass save_as to cache up to 5000 rows as a per-chat frame for local follow-up filtering.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.run_query,
        execute: async ({ sql, save_as }) => this.safeTool(TOOL_LABELS.run_query, capture, async () => {
          const issues = validateSqlSchema(sql, tables);
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length) {
            const message = errors.map((issue) => issue.message).join(" ");
            return this.output(false, `Schema validation failed: ${message}`, { error: message });
          }
          status(save_as ? "Running query & caching rows…" : "Running query…");
          const result = await this.executeLakeQuery(sql, save_as ? FRAME_QUERY_LIMIT : RESULT_PERSIST_MAX_ROWS);
          capture.sql = sql;
          capture.result = result;
          if (result.error) {
            persist();
            return this.output(false, `Query failed: ${result.error}`, { error: result.error, sql, result });
          }
          turn.successfulQuery = true;
          if (save_as && result.row_count > 0) this.saveFrame(save_as, result.columns, result.rows, sql);
          persist();
          const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message).join(" ");
          const summary = `${warnings ? `Schema notes: ${warnings}\n` : ""}${summarizeResult(result)}${save_as && result.row_count > 0 ? `\nSaved frame '${save_as}' (${result.row_count} rows).` : ""}`;
          return this.output(true, summary, { error: null, sql, result, frames: this.frameMetadata() });
        }),
      }),
      check_schema: tool({
        description: "Validate proposed SQL against the real options table and column names without executing it.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.check_schema,
        execute: async ({ sql }) => this.safeTool(TOOL_LABELS.check_schema, capture, () => {
          const issues = validateSqlSchema(sql, tables).map((issue) => `[${issue.severity}] ${issue.message}`);
          return this.output(issues.every((issue) => !issue.startsWith("[error]")), issues.join("\n") || "SQL matches the current schema.", { issues });
        }),
      }),
      list_frames: tool({
        description: "List this chat's cached result frames, including columns, row counts, age, and value sketches.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.list_frames,
        execute: async () => this.safeTool(TOOL_LABELS.list_frames, capture, () => this.output(true, this.frameCatalog(), { error: null, frames: this.frameMetadata() })),
      }),
      filter_frame: tool({
        description: "Filter, sort, project, and limit a cached frame without querying the lake. where and sort use expressions over column names with ==, !=, <, <=, >, >=, &&, ||, !, abs, min, max, and round.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.filter_frame,
        execute: async (args) => this.safeTool(TOOL_LABELS.filter_frame, capture, () => {
          const frame = this.getFrame(args.frame);
          if (!frame) return this.output(false, `No cached frame '${args.frame}'.`, { error: `No frame '${args.frame}'.` });
          if (Date.now() - frame.fetched_at > FRAME_TTL_MS) {
            return this.output(false, `Frame '${args.frame}' is stale. Call refresh_frame and retry.`, { error: `Frame '${args.frame}' is stale.` });
          }
          status("Filtering cached data…");
          const result = this.filterFrame(frame, args);
          capture.result = result;
          capture.sql = `-- slice of cached frame '${frame.name}'\n-- source: ${frame.sql}`;
          const sliceSql = capture.sql;
          turn.successfulQuery = true;
          if (args.save_as && result.row_count > 0) this.saveFrame(args.save_as, result.columns, result.rows, frame.sql);
          persist();
          return this.output(true, `${summarizeResult(result)}${args.save_as ? `\nSaved frame '${args.save_as}'.` : ""}`, { error: null, sql: sliceSql, result, frames: this.frameMetadata() });
        }),
      }),
      refresh_frame: tool({
        description: "Re-run a cached frame's source query after it becomes stale.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.refresh_frame,
        execute: async ({ frame: name }) => this.safeTool(TOOL_LABELS.refresh_frame, capture, async () => {
          const frame = this.getFrame(name);
          if (!frame) return this.output(false, `No cached frame '${name}'.`, { error: `No frame '${name}'.` });
          status("Refreshing cached data…");
          const result = await this.executeLakeQuery(frame.sql, FRAME_QUERY_LIMIT);
          capture.sql = frame.sql;
          capture.result = result;
          if (result.error) {
            persist();
            return this.output(false, `Refresh failed: ${result.error}`, { error: result.error, sql: frame.sql, result });
          }
          turn.successfulQuery = true;
          if (result.row_count > 0) this.saveFrame(name, result.columns, result.rows, frame.sql);
          persist();
          return this.output(true, `Refreshed frame '${name}' (${result.row_count} rows).`, { error: null, sql: frame.sql, result, frames: this.frameMetadata() });
        }),
      }),
      render_chart: tool({
        description: "Validate a chart specification for the most recent query result. Call after run_query or filter_frame when the user requested a chart.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.render_chart,
        execute: async (args) => this.safeTool(TOOL_LABELS.render_chart, capture, () => {
          const result = capture.result;
          if (!result || result.error) return this.output(false, "No successful result to chart.", { error: "No successful result to chart." });
          if (!result.columns.includes(args.x) || !result.columns.includes(args.y)) {
            const error = `Result lacks '${args.x}' or '${args.y}'. Available columns: ${result.columns.join(", ")}.`;
            return this.output(false, error, { error });
          }
          capture.chart = {
            kind: args.kind,
            x: args.x,
            y: args.y,
            ...(args.title ? { title: args.title } : {}),
            ...(args.series && result.columns.includes(args.series) ? { series: args.series } : {}),
            ...(args.xLabel ? { xLabel: args.xLabel } : {}),
            ...(args.yLabel ? { yLabel: args.yLabel } : {}),
          };
          persist();
          return this.output(true, "Chart specification validated.", { error: null, chart: capture.chart });
        }),
      }),
      get_news: tool({
        description: "Fetch recent headlines for one ticker when explaining why a stock, option volume, or implied volatility moved.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_news,
        execute: async ({ symbol, limit }) => this.safeTool(TOOL_LABELS.get_news, capture, async () => {
          const result = await this.fetchNews(symbol.toUpperCase(), limit);
          if (result.error) return this.output(false, `News temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No recent headlines found for ${result.symbol}.`;
          return this.output(true, summary, { error: null });
        }),
      }),
      web_search: tool({
        description: "Search for current market commentary or events and return up to five citable links.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.web_search,
        execute: async ({ query, max_results }) => this.safeTool(TOOL_LABELS.web_search, capture, async () => {
          const result = await this.searchWeb(query, max_results);
          if (result.error) return this.output(false, `Web search temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.results.length ? result.results.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No results found for "${result.query}".`;
          return this.output(true, summary, { error: null });
        }),
      }),
      eco_calendar: tool({
        description: "Fetch scheduled macro events for the next 7 to 90 days.",
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.eco_calendar,
        execute: async ({ days }) => this.safeTool(TOOL_LABELS.eco_calendar, capture, async () => {
          const result = await this.fetchEconomicCalendar(days);
          if (result.error) return this.output(false, `Macro calendar temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`).join("\n") : "No scheduled macro events in the requested window.";
          return this.output(true, summary, { error: null });
        }),
      }),
    };
  }

  override async onChatMessage(_onFinish: unknown, options: OnChatMessageOptions): Promise<Response> {
    this.ensureCopilotSchema();
    this.cleanupRetention();
    if (!this.env.COPILOT_MODEL?.trim()) return Response.json({ error: "COPILOT_MODEL is not configured" }, { status: 503 });
    if (!this.env.OPEN_ROUTER_KEY?.trim()) return Response.json({ error: "Copilot is not configured" }, { status: 503 });

    const totalBudget = positiveInt(this.env.COPILOT_MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_DEFAULT, OUTPUT_TOKENS_MAX);
    if (!options.continuation) this.resetTurnBudget(options.requestId, totalBudget);
    const budget = this.readTurnBudget();
    const capture = JSON.parse(budget.capture_json) as Capture;
    const turn = { used: budget.used_output_tokens, successfulQuery: budget.successful_query === 1 };
    this.stash({ turnId: budget.turn_id, usedOutputTokens: turn.used });

    const historyCharsMax = positiveInt(this.env.COPILOT_MAX_HISTORY_CHARS, HISTORY_CHARS_DEFAULT, HISTORY_CHARS_DEFAULT);
    let messages: ModelMessage[];
    try {
      messages = boundedMessages(this.messages, historyCharsMax);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorStream = createUIMessageStream<CopilotMessage>({
        originalMessages: this.messages as CopilotMessage[],
        execute: ({ writer }) => writer.write({ type: "error", errorText: message }),
      });
      return createUIMessageStreamResponse({ stream: errorStream });
    }
    const tables = await this.loadSchema();
    const latestQuestion = [...this.messages].reverse().find((message) => message.role === "user")
      ?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").toLowerCase() ?? "";
    const requestedFrame = this.frameMetadata().find((frame) => latestQuestion.includes(frame.name.toLowerCase()));
    const originValue = typeof options.body?.origin === "string" ? options.body.origin : "";
    const origin = /^https?:\/\//.test(originValue) ? originValue : "https://robs-options-slop-dev.pages.dev";
    const model = createCopilotModel(this.env, origin);
    let wroteAnswerStatus = false;

    const stream = createUIMessageStream<CopilotMessage>({
      originalMessages: this.messages as CopilotMessage[],
      onError: (error) => error instanceof Error ? error.message : String(error),
      execute: ({ writer }) => {
        const status = (value: string) => writer.write({ type: "data-status", data: { status: value }, transient: true });
        status("Reasoning over the data…");
        const tools = this.createTools(tables, capture, status, turn);
        const result = streamText({
          model,
          system: systemPrompt(schemaToPrompt(tables)),
          messages,
          tools,
          stopWhen: isStepCount(AGENT_ITERATIONS_MAX),
          abortSignal: options.abortSignal,
          providerOptions: {
            openrouter: { reasoning: { effort: normalizeReasoningEffort(this.env.COPILOT_REASONING_EFFORT) } },
          },
          prepareStep: ({ stepNumber }) => {
            const remaining = budget.total_output_tokens - turn.used;
            if (remaining < 256) throw new Error("Copilot output-token budget exhausted before a final answer");
            if (stepNumber >= AGENT_ITERATIONS_MAX - 1) {
              return { activeTools: [], toolChoice: "none", maxOutputTokens: remaining };
            }
            const toolBudget = Math.max(256, Math.min(TOOL_ROUND_TOKENS_MAX, remaining - FINAL_TOKEN_RESERVE));
            return {
              maxOutputTokens: toolBudget,
              toolChoice: turn.successfulQuery
                ? "auto"
                : { type: "tool", toolName: requestedFrame && stepNumber === 0 ? "filter_frame" : "run_query" },
            };
          },
          onChunk: ({ chunk }) => {
            if (!wroteAnswerStatus && (chunk.type === "text-start" || chunk.type === "text-delta")) {
              wroteAnswerStatus = true;
              status("Writing answer…");
            }
          },
          onStepFinish: (step) => {
            const outputTokens = step.usage.outputTokens ?? Math.max(1, Math.ceil(step.text.length / 4));
            turn.used = Math.min(budget.total_output_tokens, turn.used + outputTokens);
            this.writeTurnState(turn.used, turn.successfulQuery, capture);
          },
          onFinish: () => {
            console.log(JSON.stringify({
              copilotChat: true,
              model: this.env.COPILOT_MODEL,
              outputTokens: turn.used,
              toolsProducedResult: capture.result !== null,
            }));
          },
        });
        writer.merge(result.toUIMessageStream<CopilotMessage>({
          sendReasoning: true,
          messageMetadata: ({ part }) => part.type === "finish" ? { model: this.env.COPILOT_MODEL, createdAt: Date.now() } : undefined,
        }));
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  protected override sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (!("output" in part) || part.state !== "output-available" || !part.output || typeof part.output !== "object") return part;
        const output = part.output as ToolOutput;
        return {
          ...part,
          output: {
            ...output,
            summary: typeof output.summary === "string" ? output.summary.slice(0, MAX_TOOL_SUMMARY_CHARS) : "Tool completed.",
            ...(output.sql !== undefined ? { sql: String(output.sql).slice(0, MAX_TOOL_SUMMARY_CHARS) } : {}),
            ...(output.result !== undefined ? { result: boundedResult(output.result) } : {}),
            ...(output.frames !== undefined ? { frames: output.frames.slice(0, MAX_FRAMES) } : {}),
          },
        };
      }),
    };
  }
}
