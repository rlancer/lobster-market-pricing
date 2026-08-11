export interface CopilotEnv {
  OPEN_ROUTER_KEY: string;
  COPILOT_MODEL: string;
  COPILOT_REASONING_EFFORT: string;
  COPILOT_MAX_OUTPUT_TOKENS?: string;
  COPILOT_MAX_HISTORY_CHARS?: string;
}

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

interface NewsResult {
  symbol: string;
  items: { title: string; link: string }[];
  error?: string;
}

interface SearchResult {
  query: string;
  results: { title: string; link: string }[];
  error?: string;
}

interface CalendarResult {
  items: { date: string; time?: string; title: string }[];
  error?: string;
}

export interface CopilotDeps {
  schema(): Promise<LakeTable[]>;
  query(sql: string, limit: number): Promise<QueryResult>;
  /** Store a completed chat result under `chatId` so a disconnected client can resume it. */
  persistResult(chatId: string, payload: string): Promise<void>;
  news(symbol: string, limit: number): Promise<NewsResult>;
  webSearch(query: string, limit: number): Promise<SearchResult>;
  econCalendar(days: number): Promise<CalendarResult>;
}

interface ChartSpec {
  title?: string;
  kind: "line" | "area" | "scatter" | "bar";
  x: string;
  y: string;
  series?: string;
  xLabel?: string;
  yLabel?: string;
}

interface FrameColumnSketch {
  type: "number" | "string" | "boolean" | "other";
  min?: number;
  max?: number;
  values?: string[];
}

interface DataFrame {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  summary: Record<string, FrameColumnSketch>;
  sql: string;
  fetched_at: number;
}

interface ChatSession {
  frames: Map<string, DataFrame>;
  lastAccess: number;
  running: boolean;
}

interface Capture {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

type OpenRouterMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ToolResult {
  ok: boolean;
  error?: string | null;
  summary?: string;
  issues?: string[];
}

interface ProgressEvent {
  kind: string;
  [key: string]: unknown;
}

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const APP_TITLE = "Open Interest Options Workspace";
const RAW_BODY_MAX_BYTES = 96_000;
const QUESTION_MAX_CHARS = 4_000;
const HISTORY_MESSAGES_MAX = 16;
const HISTORY_MESSAGE_MAX_CHARS = 6_000;
const HISTORY_CHARS_DEFAULT = 48_000;
const OUTPUT_TOKENS_DEFAULT = 8_192;
const OUTPUT_TOKENS_MAX = 16_384;
const AGENT_ITERATIONS_MAX = 10;
const TOOL_ROUND_TOKENS_MAX = 2_048;
const FINAL_TOKEN_RESERVE = 1_024;
const FRAME_QUERY_LIMIT = 5_000;
const FRAME_TTL_MS = 15 * 60_000;
const MAX_FRAMES = 8;
const MAX_FRAME_ROWS = 100_000;
const MAX_CHAT_SESSIONS = 100;
const SESSION_TTL_MS = 30 * 60_000;
// Cap rows persisted for a resumed answer (mirrors the client's render cap).
const RESULT_PERSIST_MAX_ROWS = 200;
const MAX_TOOL_SUMMARY_CHARS = 12_000;

const sessions = new Map<string, ChatSession>();

const TOOL_LABELS: Record<string, string> = {
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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_query",
      description: "Execute one read-only DataFusion SQL SELECT/WITH query against the options Iceberg lake. SQL is validated against the real schema first. Pass save_as to cache up to 5000 rows as a per-chat frame for local follow-up filtering.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["sql"],
        properties: {
          sql: { type: "string", description: "A single read-only SQL query." },
          save_as: { type: "string", description: "Optional frame name for this result." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_schema",
      description: "Validate proposed SQL against the real options table and column names without executing it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["sql"],
        properties: { sql: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_frames",
      description: "List this chat's cached result frames, including columns, row counts, age, and value sketches.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_frame",
      description: "Filter, sort, project, and limit a cached frame without querying the lake. where and sort use expressions over column names with ==, !=, <, <=, >, >=, &&, ||, !, abs, min, max, and round.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["frame"],
        properties: {
          frame: { type: "string" },
          where: { type: "string" },
          sort: { type: "string" },
          limit: { type: "integer", minimum: 0, maximum: 5000 },
          project: { type: "array", items: { type: "string" }, maxItems: 100 },
          save_as: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_frame",
      description: "Re-run a cached frame's source query after it becomes stale.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["frame"],
        properties: { frame: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_chart",
      description: "Validate a chart specification for the most recent query result. Call after run_query or filter_frame when the user requested a chart.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["line", "area", "scatter", "bar"] },
          x: { type: "string" },
          y: { type: "string" },
          series: { type: "string" },
          xLabel: { type: "string" },
          yLabel: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "Fetch recent headlines for one ticker when explaining why a stock, option volume, or implied volatility moved.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["symbol"],
        properties: {
          symbol: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "eco_calendar",
      description: "Fetch scheduled macro events for the next 7 to 90 days.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { days: { type: "integer", minimum: 7, maximum: 90 } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search for current market commentary or events and return up to five citable links.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
] as const;

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : fallback;
}

function cleanSessions(now: number): void {
  for (const [id, session] of sessions) {
    if (!session.running && now - session.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
  if (sessions.size < MAX_CHAT_SESSIONS) return;
  const idle = [...sessions.entries()]
    .filter(([, session]) => !session.running)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  while (sessions.size >= MAX_CHAT_SESSIONS && idle.length) {
    const entry = idle.shift();
    if (entry) sessions.delete(entry[0]);
  }
}

function getSession(chatId: string): ChatSession {
  const now = Date.now();
  cleanSessions(now);
  let session = sessions.get(chatId);
  if (!session) {
    session = { frames: new Map(), lastAccess: now, running: false };
    sessions.set(chatId, session);
  }
  session.lastAccess = now;
  return session;
}

async function readBodyBounded(req: Request): Promise<string> {
  const declared = Number(req.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > RAW_BODY_MAX_BYTES) throw new RangeError("chat payload is too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RAW_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new RangeError("chat payload is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function normalizeRequest(body: unknown, historyCharsMax: number): {
  question: string;
  chatId: string;
  history: HistoryMessage[];
} {
  const record = asRecord(body);
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!question) throw new Error("question is required");
  if (question.length > QUESTION_MAX_CHARS) throw new Error(`question exceeds ${QUESTION_MAX_CHARS} characters`);
  const chatId = typeof record.chat_id === "string" ? record.chat_id.trim() : "";
  if (!/^[0-9A-Za-z_-]{1,128}$/.test(chatId)) throw new Error("chat_id is invalid");
  if (!Array.isArray(record.history)) throw new Error("history must be an array");

  const candidates: HistoryMessage[] = [];
  for (const item of record.history.slice(-HISTORY_MESSAGES_MAX)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    candidates.push({ role: message.role, content: message.content.slice(0, HISTORY_MESSAGE_MAX_CHARS) });
  }
  const history: HistoryMessage[] = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const message = candidates[i];
    if (chars + message.content.length > historyCharsMax) break;
    history.unshift(message);
    chars += message.content.length;
  }
  return { question, chatId, history };
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
    "- To answer a market-data question, ALWAYS write a read-only query and execute it with run_query. Never return only SQL. Always finish with a substantive plain-English answer grounded in the result.",
    "- Use only table and column names in the schema. Never invent identifiers. check_schema and run_query validate them.",
    "- End the top-level query with LIMIT. Prefer explicit columns. No OFFSET, CROSS JOIN, or named WINDOW clauses. WHERE comes before QUALIFY.",
    "- implied_vol is decimal (0.25 = 25%). spot_price is the spot column. expiration is TEXT; DTE is CAST(expiration AS DATE) - CURRENT_DATE.",
    "- Avoid expensive unfiltered joins, high-cardinality DISTINCT, ARRAY_AGG/STRING_AGG, and large window partitions. Filter before joining; use approx_* aggregates where possible.",
    "- If a query fails, fix it and retry. If it returns no rows, say so and suggest a useful looser criterion.",
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

const SQL_ALIAS_KEYWORDS = new Set([
  "on", "as", "inner", "left", "right", "full", "outer", "cross", "join", "where", "using",
  "select", "from", "group", "by", "having", "order", "limit", "qualify", "with", "and", "or",
  "not", "case", "when", "then", "else", "end", "union", "all", "intersect", "except", "exists",
  "in", "is", "null", "distinct", "over", "partition", "rows", "between", "like",
]);

function validateSqlSchema(sql: string, tables: LakeTable[]): ValidatedIssue[] {
  const tableNames = tables.map((table) => table.name);
  const lowerTables = new Set(tableNames.map((table) => table.toLowerCase()));
  const columnsByTable = new Map<string, Set<string>>();
  for (const table of tables) {
    columnsByTable.set(table.name.toLowerCase(), new Set(table.columns.map((column) => column.name.toLowerCase())));
  }

  let stripped = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") {
      stripped += sql[i];
      continue;
    }
    stripped += " ";
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") { j += 2; continue; }
        break;
      }
      j++;
    }
    i = j;
  }

  const cteNames = new Set<string>();
  const cteRe = /([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;
  let cteMatch: RegExpExecArray | null;
  while ((cteMatch = cteRe.exec(stripped))) cteNames.add(cteMatch[1].toLowerCase());

  const issues: ValidatedIssue[] = [];
  const issuedTables = new Set<string>();
  const aliasToTable = new Map<string, string>();
  const refRe = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  let match: RegExpExecArray | null;
  while ((match = refRe.exec(stripped))) {
    const ref = match[1];
    const alias = match[2] && !SQL_ALIAS_KEYWORDS.has(match[2].toLowerCase()) ? match[2].toLowerCase() : null;
    const dot = ref.indexOf(".");
    const bare = dot === -1 ? ref : ref.slice(dot + 1);
    const namespace = dot === -1 ? null : ref.slice(0, dot);
    const lowerBare = bare.toLowerCase();
    if (cteNames.has(lowerBare)) continue;
    if (lowerTables.has(lowerBare)) {
      if (alias) aliasToTable.set(alias, lowerBare);
      if (namespace && namespace.toLowerCase() !== "options" && !issuedTables.has(lowerBare)) {
        issuedTables.add(lowerBare);
        issues.push({ severity: "error", message: `Unknown schema '${namespace}'. Tables live in options (for example options.${bare}).` });
      }
      continue;
    }
    if (issuedTables.has(lowerBare)) continue;
    issuedTables.add(lowerBare);
    issues.push({
      severity: namespace ? "error" : "warning",
      message: namespace
        ? `Unknown table '${ref}'. Available tables: ${tableNames.map((name) => `options.${name}`).join(", ")}.`
        : `'${ref}' is not a known table or CTE. Available tables: ${tableNames.map((name) => `options.${name}`).join(", ")}.`,
    });
  }

  const colRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let columnMatch: RegExpExecArray | null;
  while ((columnMatch = colRe.exec(stripped))) {
    const qualifier = columnMatch[1].toLowerCase();
    const column = columnMatch[2].toLowerCase();
    const table = aliasToTable.get(qualifier) ?? (lowerTables.has(qualifier) ? qualifier : null);
    if (!table) continue;
    const columns = columnsByTable.get(table);
    if (columns && !columns.has(column)) {
      issues.push({
        severity: "warning",
        message: `Unknown column '${columnMatch[1]}.${columnMatch[2]}': options.${table} columns are ${[...columns].sort().join(", ")}.`,
      });
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

function saveFrame(session: ChatSession, frame: DataFrame): void {
  if (!frame.row_count) return;
  if (frame.rows.length > MAX_FRAME_ROWS) {
    frame.rows = frame.rows.slice(0, MAX_FRAME_ROWS);
    frame.row_count = frame.rows.length;
  }
  session.frames.set(frame.name, frame);
  while (session.frames.size > MAX_FRAMES) {
    const oldest = [...session.frames.entries()].sort((a, b) => a[1].fetched_at - b[1].fetched_at)[0];
    if (!oldest) break;
    session.frames.delete(oldest[0]);
  }
}

function frameCatalog(session: ChatSession): string {
  if (!session.frames.size) return "No cached frames in this chat yet.";
  return [...session.frames.values()].map((frame) => {
    const age = Math.max(0, Math.round((Date.now() - frame.fetched_at) / 60_000));
    const columns = frame.columns.map((column) => {
      const sketch = frame.summary[column];
      if (!sketch) return column;
      if (sketch.type === "number") return `${column}: number ${sketch.min ?? "?"}..${sketch.max ?? "?"}`;
      if (sketch.type === "string" && sketch.values?.length) return `${column}: string {${sketch.values.join(", ")}}`;
      return `${column}: ${sketch.type}`;
    }).join(", ");
    return `- '${frame.name}': ${frame.row_count} rows × ${frame.columns.length} cols, age ${age < 1 ? "<1" : age} min — ${columns}`;
  }).join("\n").slice(0, MAX_TOOL_SUMMARY_CHARS);
}

type ExprNode =
  | { type: "literal"; value: unknown }
  | { type: "column"; name: string }
  | { type: "unary"; op: "!" | "-"; value: ExprNode }
  | { type: "binary"; op: string; left: ExprNode; right: ExprNode }
  | { type: "call"; name: string; args: ExprNode[] };

interface ExprToken { type: "number" | "string" | "identifier" | "operator" | "punctuation" | "eof"; value: string; }

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

function evaluateExpr(node: ExprNode, row: Record<string, unknown>): unknown {
  if (node.type === "literal") return node.value;
  if (node.type === "column") return row[node.name] ?? null;
  if (node.type === "unary") {
    const value = evaluateExpr(node.value, row);
    return node.op === "!" ? !value : -Number(value);
  }
  if (node.type === "call") {
    const args = node.args.map((arg) => Number(evaluateExpr(arg, row)));
    if (node.name === "abs") return Math.abs(args[0]);
    if (node.name === "min") return Math.min(...args);
    if (node.name === "max") return Math.max(...args);
    return Math.round(args[0]);
  }
  if (node.op === "&&") return evaluateExpr(node.left, row) === true && evaluateExpr(node.right, row) === true;
  if (node.op === "||") return evaluateExpr(node.left, row) === true || evaluateExpr(node.right, row) === true;
  const left = evaluateExpr(node.left, row);
  const right = evaluateExpr(node.right, row);
  if (node.op === "==") return left === right;
  if (node.op === "!=") return left !== right;
  if (left == null || right == null) return false;
  if (node.op === "<") return left < right;
  if (node.op === "<=") return left <= right;
  if (node.op === ">") return left > right;
  return left >= right;
}

function sliceFrame(frame: DataFrame, args: Record<string, unknown>): QueryResult {
  let columns = frame.columns;
  let rows = frame.rows;
  const columnSet = new Set(columns);
  if (typeof args.where === "string" && args.where.trim()) {
    const expression = new ExprParser(tokenize(args.where), columnSet).parse();
    rows = rows.filter((row) => evaluateExpr(expression, row) === true);
  }
  if (typeof args.sort === "string" && args.sort.trim() && rows.length > 1) {
    const expression = new ExprParser(tokenize(args.sort), columnSet).parse();
    rows = rows.map((row, index) => ({ row, index, key: evaluateExpr(expression, row) }))
      .sort((a, b) => {
        const order = typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : String(a.key ?? "").localeCompare(String(b.key ?? ""));
        return order || a.index - b.index;
      })
      .map((entry) => entry.row);
  }
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) rows = rows.slice(0, Math.max(0, Math.min(Math.round(args.limit), FRAME_QUERY_LIMIT)));
  if (Array.isArray(args.project)) {
    const requested = new Set(args.project.filter((value): value is string => typeof value === "string" && columnSet.has(value)));
    if (requested.size) {
      columns = columns.filter((column) => requested.has(column));
      rows = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    }
  }
  return { columns, rows, row_count: rows.length, truncated: false, limit: rows.length };
}

function safeArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  return asRecord(JSON.parse(raw));
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

async function executeTool(
  call: ToolCall,
  session: ChatSession,
  tables: LakeTable[],
  capture: Capture,
  deps: CopilotDeps,
  emit: (event: ProgressEvent) => Promise<void>,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = safeArgs(call.function.arguments);
  } catch (error) {
    return { ok: false, error: `Invalid tool arguments: ${error}`, summary: "Tool arguments were not valid JSON." };
  }

  try {
    switch (call.function.name) {
      case "check_schema": {
        const issues = validateSqlSchema(stringArg(args, "sql"), tables);
        return { ok: issues.length === 0, issues: issues.map((issue) => `[${issue.severity}] ${issue.message}`) };
      }
      case "run_query": {
        const sql = stringArg(args, "sql");
        const issues = validateSqlSchema(sql, tables);
        const errors = issues.filter((issue) => issue.severity === "error");
        if (errors.length) {
          const message = errors.map((issue) => issue.message).join(" ");
          return { ok: false, error: message, summary: `Schema validation failed: ${message}` };
        }
        const saveAs = typeof args.save_as === "string" ? args.save_as.trim().slice(0, 80) : "";
        await emit({ kind: "status", status: saveAs ? "Running query & caching rows…" : "Running query…" });
        const result = await deps.query(sql, saveAs ? FRAME_QUERY_LIMIT : 200);
        capture.sql = sql;
        capture.result = result;
        if (result.error) return { ok: false, error: result.error, summary: `Query failed: ${result.error}` };
        if (saveAs && result.row_count > 0) {
          saveFrame(session, {
            name: saveAs,
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            summary: buildFrameSummary(result.columns, result.rows),
            sql,
            fetched_at: Date.now(),
          });
        }
        const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message).join(" ");
        let summary = `${warnings ? `Schema notes: ${warnings}\n` : ""}${summarizeResult(result)}`;
        if (saveAs && result.row_count > 0) summary += `\nSaved frame '${saveAs}' (${result.row_count} rows).`;
        return { ok: true, error: null, summary };
      }
      case "list_frames":
        return { ok: true, error: null, summary: frameCatalog(session) };
      case "filter_frame": {
        const name = stringArg(args, "frame");
        const frame = session.frames.get(name);
        if (!frame) return { ok: false, error: `No frame '${name}'.`, summary: `No cached frame '${name}'.` };
        if (Date.now() - frame.fetched_at > FRAME_TTL_MS) {
          return { ok: false, error: `Frame '${name}' is stale. Call refresh_frame and retry.`, summary: `Frame '${name}' is stale.` };
        }
        await emit({ kind: "status", status: "Filtering cached data…" });
        const result = sliceFrame(frame, args);
        capture.result = result;
        capture.sql = `-- slice of cached frame '${frame.name}'\n-- source: ${frame.sql}`;
        const saveAs = typeof args.save_as === "string" ? args.save_as.trim().slice(0, 80) : "";
        if (saveAs && result.row_count > 0) {
          saveFrame(session, {
            name: saveAs,
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            summary: buildFrameSummary(result.columns, result.rows),
            sql: frame.sql,
            fetched_at: Date.now(),
          });
        }
        return { ok: true, error: null, summary: `${summarizeResult(result)}${saveAs ? `\nSaved frame '${saveAs}'.` : ""}` };
      }
      case "refresh_frame": {
        const name = stringArg(args, "frame");
        const frame = session.frames.get(name);
        if (!frame) return { ok: false, error: `No frame '${name}'.`, summary: `No cached frame '${name}'.` };
        await emit({ kind: "status", status: "Refreshing cached data…" });
        const result = await deps.query(frame.sql, FRAME_QUERY_LIMIT);
        capture.sql = frame.sql;
        capture.result = result;
        if (result.error) return { ok: false, error: result.error, summary: `Refresh failed: ${result.error}` };
        if (result.row_count > 0) {
          saveFrame(session, {
            ...frame,
            columns: result.columns,
            rows: result.rows,
            row_count: result.row_count,
            summary: buildFrameSummary(result.columns, result.rows),
            fetched_at: Date.now(),
          });
        }
        return { ok: true, error: null, summary: `Refreshed frame '${name}' (${result.row_count} rows).` };
      }
      case "render_chart": {
        const result = capture.result;
        if (!result || result.error) return { ok: false, error: "No successful result to chart." };
        const x = stringArg(args, "x");
        const y = stringArg(args, "y");
        if (!result.columns.includes(x) || !result.columns.includes(y)) {
          return { ok: false, error: `Result lacks '${x}' or '${y}'. Available columns: ${result.columns.join(", ")}.` };
        }
        const kind = ["line", "area", "scatter", "bar"].includes(String(args.kind)) ? String(args.kind) as ChartSpec["kind"] : "line";
        capture.chart = {
          kind,
          x,
          y,
          ...(typeof args.title === "string" ? { title: args.title.slice(0, 160) } : {}),
          ...(typeof args.series === "string" && result.columns.includes(args.series) ? { series: args.series } : {}),
          ...(typeof args.xLabel === "string" ? { xLabel: args.xLabel.slice(0, 80) } : {}),
          ...(typeof args.yLabel === "string" ? { yLabel: args.yLabel.slice(0, 80) } : {}),
        };
        return { ok: true, error: null, summary: "Chart specification validated." };
      }
      case "get_news": {
        const symbol = stringArg(args, "symbol").toUpperCase();
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.round(args.limit))) : 8;
        const result = await deps.news(symbol, limit);
        if (result.error) return { ok: false, summary: `News temporarily unavailable: ${result.error}` };
        return { ok: true, summary: result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No recent headlines found for ${result.symbol}.` };
      }
      case "eco_calendar": {
        const days = typeof args.days === "number" ? Math.max(7, Math.min(90, Math.round(args.days))) : 30;
        const result = await deps.econCalendar(days);
        if (result.error) return { ok: false, summary: `Macro calendar temporarily unavailable: ${result.error}` };
        return { ok: true, summary: result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`).join("\n") : "No scheduled macro events in the requested window." };
      }
      case "web_search": {
        const query = stringArg(args, "query").slice(0, 200);
        const limit = typeof args.max_results === "number" ? Math.max(1, Math.min(5, Math.round(args.max_results))) : 5;
        const result = await deps.webSearch(query, limit);
        if (result.error) return { ok: false, summary: `Web search temporarily unavailable: ${result.error}` };
        return { ok: true, summary: result.results.length ? result.results.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No results found for "${result.query}".` };
      }
      default:
        return { ok: false, error: `Unknown tool '${call.function.name}'.`, summary: "Unknown tool." };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, summary: `${TOOL_LABELS[call.function.name] ?? call.function.name} failed: ${message}` };
  }
}

interface ModelRound {
  content: string;
  toolCalls: ToolCall[];
  outputTokens: number;
}

function reasoningText(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning === "string") return delta.reasoning;
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (Array.isArray(delta.reasoning_details)) {
    const last = delta.reasoning_details[delta.reasoning_details.length - 1];
    if (last && typeof last === "object" && "text" in last && typeof last.text === "string") return last.text;
  }
  return "";
}

async function modelRound(
  env: CopilotEnv,
  origin: string,
  messages: OpenRouterMessage[],
  maxTokens: number,
  withTools: boolean,
  emit: (event: ProgressEvent) => Promise<void>,
): Promise<ModelRound> {
  const payload: Record<string, unknown> = {
    model: env.COPILOT_MODEL,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    reasoning: { effort: env.COPILOT_REASONING_EFFORT },
  };
  if (withTools) {
    payload.tools = TOOLS;
    payload.tool_choice = "auto";
    payload.parallel_tool_calls = false;
  }
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPEN_ROUTER_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": origin || "https://robs-options-slop-dev.pages.dev",
      "X-Title": APP_TITLE,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`OpenRouter ${response.status}: ${detail || response.statusText}`);
  }
  if (!response.body) throw new Error("OpenRouter returned no response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let generatedChars = 0;
  let usageTokens: number | null = null;
  const toolParts = new Map<number, ToolCall>();
  const started = new Set<number>();

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = asRecord(JSON.parse(data));
    } catch {
      return;
    }
    if (parsed.error) {
      const error = parsed.error;
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : JSON.stringify(error);
      throw new Error(`OpenRouter stream error: ${message}`);
    }
    if (parsed.usage && typeof parsed.usage === "object" && "completion_tokens" in parsed.usage && typeof parsed.usage.completion_tokens === "number") {
      usageTokens = parsed.usage.completion_tokens;
    }
    if (!Array.isArray(parsed.choices) || !parsed.choices.length) return;
    const choice = parsed.choices[0];
    if (!choice || typeof choice !== "object" || !("delta" in choice) || !choice.delta || typeof choice.delta !== "object") return;
    const delta = choice.delta as Record<string, unknown>;
    const reasoning = reasoningText(delta);
    if (reasoning) {
      generatedChars += reasoning.length;
      await emit({ kind: "reasoning", delta: reasoning });
    }
    if (typeof delta.content === "string") {
      content += delta.content;
      generatedChars += delta.content.length;
    }
    if (!Array.isArray(delta.tool_calls)) return;
    for (const rawPart of delta.tool_calls) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      const index = typeof part.index === "number" ? part.index : 0;
      const current = toolParts.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (typeof part.id === "string") current.id = part.id;
      if (part.function && typeof part.function === "object") {
        const fn = part.function as Record<string, unknown>;
        if (typeof fn.name === "string") current.function.name += fn.name;
        if (typeof fn.arguments === "string") {
          current.function.arguments += fn.arguments;
          generatedChars += fn.arguments.length;
        }
      }
      toolParts.set(index, current);
      if (!started.has(index) && current.id && current.function.name) {
        started.add(index);
        await emit({ kind: "tool_start", name: current.function.name, display: TOOL_LABELS[current.function.name] ?? current.function.name.replaceAll("_", " "), callId: current.id });
      }
      if (current.id && current.function.arguments) {
        await emit({ kind: "tool_args", name: current.function.name, callId: current.id, args: current.function.arguments });
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      await processLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processLine(buffer);

  const toolCalls = [...toolParts.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  for (const call of toolCalls) {
    if (!call.id || !call.function.name) throw new Error("OpenRouter returned an incomplete tool call");
  }
  return {
    content: content.trim(),
    toolCalls,
    outputTokens: usageTokens ?? Math.max(1, Math.ceil(generatedChars / 4)),
  };
}

function frameMetadata(session: ChatSession): { name: string; columns: string[]; row_count: number; sql: string; fetched_at: number }[] {
  return [...session.frames.values()].map((frame) => ({
    name: frame.name,
    columns: frame.columns,
    row_count: frame.row_count,
    sql: frame.sql,
    fetched_at: frame.fetched_at,
  }));
}

async function runAgent(
  env: CopilotEnv,
  origin: string,
  question: string,
  history: HistoryMessage[],
  session: ChatSession,
  deps: CopilotDeps,
  emit: (event: ProgressEvent) => Promise<void>,
): Promise<{ answer: string; capture: Capture; usedOutputTokens: number }> {
  await emit({ kind: "status", status: "Reading schema…" });
  const tables = await deps.schema();
  await emit({ kind: "status", status: "Reasoning over the data…" });
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt(schemaToPrompt(tables)) },
    ...history.map((message): OpenRouterMessage => ({ role: message.role, content: message.content })),
    { role: "user", content: question },
  ];
  const capture: Capture = { sql: null, result: null, chart: null };
  const totalBudget = positiveInt(env.COPILOT_MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_DEFAULT, OUTPUT_TOKENS_MAX);
  let usedOutputTokens = 0;

  for (let iteration = 0; iteration < AGENT_ITERATIONS_MAX; iteration++) {
    const remaining = totalBudget - usedOutputTokens;
    if (remaining < 256) throw new Error("Copilot output-token budget exhausted before a final answer");
    const withTools = iteration < AGENT_ITERATIONS_MAX - 1;
    const maxTokens = withTools
      ? Math.max(256, Math.min(TOOL_ROUND_TOKENS_MAX, remaining - FINAL_TOKEN_RESERVE))
      : remaining;
    const round = await modelRound(env, origin, messages, maxTokens, withTools, emit);
    usedOutputTokens += Math.min(round.outputTokens, remaining);

    if (round.toolCalls.length) {
      messages.push({ role: "assistant", content: round.content || null, tool_calls: round.toolCalls });
      for (const call of round.toolCalls) {
        const result = await executeTool(call, session, tables, capture, deps, emit);
        const summary = result.summary ?? result.error ?? (result.issues?.join("\n") || "Tool completed.");
        await emit({ kind: "tool_end", name: call.function.name, callId: call.id, ok: result.ok, summary: summary.slice(0, 500) });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, MAX_TOOL_SUMMARY_CHARS) });
      }
      continue;
    }

    if (round.content && capture.result) {
      await emit({ kind: "answer" });
      return { answer: round.content, capture, usedOutputTokens };
    }

    if (round.content && !capture.result && withTools) {
      messages.push({ role: "assistant", content: round.content });
      messages.push({ role: "user", content: "You must run a lake query before answering. Use run_query now, then provide the final prose answer." });
      continue;
    }

    if (withTools) {
      messages.push({ role: "user", content: "Continue: use the required tools, then give a substantive plain-English final answer." });
      continue;
    }
  }
  throw new Error("The model did not finish a prose answer within the agent iteration limit");
}

function sseResponse(readable: ReadableStream<Uint8Array>): Response {
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function copilotChat(
  req: Request,
  env: CopilotEnv,
  ctx: ExecutionContext,
  deps: CopilotDeps,
): Promise<Response> {
  let request: { question: string; chatId: string; history: HistoryMessage[] };
  try {
    const raw = await readBodyBounded(req);
    request = normalizeRequest(JSON.parse(raw), positiveInt(env.COPILOT_MAX_HISTORY_CHARS, HISTORY_CHARS_DEFAULT, HISTORY_CHARS_DEFAULT));
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
  if (!env.COPILOT_MODEL?.trim()) return Response.json({ error: "COPILOT_MODEL is not configured" }, { status: 503 });
  if (!env.OPEN_ROUTER_KEY?.trim()) return Response.json({ error: "Copilot is not configured" }, { status: 503 });

  const session = getSession(request.chatId);
  if (session.running) return Response.json({ error: "a chat request is already running for this chat_id" }, { status: 409 });
  session.running = true;
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  // Stop writing once the socket is gone. NB: Cloudflare does not reliably
  // surface a client disconnect to a streaming write (writes can keep
  // "succeeding" into a buffered stream long after the tab closed), so
  // persistence below must NOT depend on this flag ever flipping.
  let disconnected = false;
  const emit = async (event: ProgressEvent): Promise<void> => {
    if (disconnected) return;
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      disconnected = true;
    }
  };

  const work = (async () => {
    try {
      const result = await runAgent(env, req.headers.get("Origin") ?? "", request.question, request.history, session, deps, emit);
      await emit({
        kind: "result",
        answer: result.answer,
        sql: result.capture.sql,
        result: result.capture.result,
        chart: result.capture.chart,
        model: env.COPILOT_MODEL,
        frames: frameMetadata(session),
      });
      // Persist the completed result unconditionally (rows truncated). A client
      // that lost the connection mid-stream can then poll GET /api/chat/result
      // and recover it; a client that got the live stream ignores the row. Rows
      // are TTL-pruned so this never accumulates.
      const res = result.capture.result;
      const payload: ProgressEvent & { kind: "result" } = {
        kind: "result",
        answer: result.answer,
        sql: result.capture.sql,
        result: res ? { ...res, rows: res.rows.slice(0, RESULT_PERSIST_MAX_ROWS) } : res,
        chart: result.capture.chart,
        model: env.COPILOT_MODEL,
        frames: frameMetadata(session),
      };
      await deps.persistResult(request.chatId, JSON.stringify(payload)).catch(() => {
        /* resume is best-effort; the run already spent its budget */
      });
      console.log(JSON.stringify({ copilotChat: true, model: env.COPILOT_MODEL, outputTokens: result.usedOutputTokens, toolsProducedResult: result.capture.result !== null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ copilotChat: true, model: env.COPILOT_MODEL, error: message }));
      await emit({ kind: "error", message });
    } finally {
      session.running = false;
      session.lastAccess = Date.now();
      if (!disconnected) await writer.close().catch(() => undefined);
    }
  })();
  ctx.waitUntil(work);
  return sseResponse(stream.readable);
}
