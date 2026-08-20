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
import { chartFitsResult, resolveColumn } from "./chart-spec";
import { COPILOT_TOOL_DESCRIPTIONS, COPILOT_TOOL_INPUT_SCHEMAS, COPILOT_TOOL_LABELS, FRAME_QUERY_LIMIT, LAST_FRAME_NAME, createCopilotModel } from "./copilot-contract";
import {
  MAX_TOOL_SUMMARY_CHARS,
  buildFrameSummary,
  compileFrameQuery,
  formatColumnSketch,
  summarizeResult,
  type FrameColumnSketch,
  type FrameQueryArgs,
} from "./copilot-frames";
import {
  SCOPE_REJECTED_ERROR,
  classifyFinanceScope,
  latestUserText,
} from "./copilot-scope";
import { insertToolEvent, purgeExpiredToolEvents } from "./copilot-tool-events";
import {
  AGENT_ITERATIONS_MAX,
  QUERY_FORCE_FAILURES_MAX,
  nextCopilotStepPolicy,
} from "./copilot-loop";
import { applyColumnSynonyms, validateSqlSchema, type LakeTable } from "./copilot-sql";
import { formatDeskToolSummary, normalizeDeskBrief, type DeskBrief } from "./copilot-desk";
import { formatTradesToolSummary, normalizeSuggestedTrades, type SuggestedTrades } from "./copilot-trades";
import { schemaToPrompt, systemPrompt, type BotPromptProfile } from "./copilot-prompt";
import { extractShareTurns, applyCaptureToShareTurns, type ShareCapture, type ShareTurn } from "./share-turns";

export type { BotPromptProfile } from "./copilot-prompt";
export { SCHEMA_PLACEHOLDER, schemaToPrompt, systemPrompt } from "./copilot-prompt";
export type { DeskBrief } from "./copilot-desk";
export type { SuggestedTrades } from "./copilot-trades";

export interface CopilotEnv extends Cloudflare.Env {
  SCHEMA_DB: D1Database;
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

export interface ResearchToolResult {
  research?: import("./research").TickerResearch;
  summary: string;
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

interface StoredFrame extends FrameMetadata {
  summary: Record<string, FrameColumnSketch>;
}

interface Capture {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
  desk: DeskBrief | null;
  trades: SuggestedTrades | null;
}

interface ToolOutput {
  ok: boolean;
  error?: string | null;
  issues?: string[];
  summary: string;
  // Bounded presentation data carried directly on the tool output parts — the
  // frontend reads SQL/result/chart/frames/desk/trades straight from the standard AI SDK
  // tool-output parts instead of a bespoke bundle.
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  frames?: FrameMetadata[];
  research?: import("./research").TickerResearch | null;
  desk?: DeskBrief | null;
  trades?: SuggestedTrades | null;
}

interface CopilotMetadata {
  model: string;
  createdAt: number;
  /** True when this assistant turn is the finance-scope gate rejection (not model prose). */
  scopeRejected?: boolean;
  /** Turn-budget capture mirrored onto finish metadata when tool parts omit outputs. */
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  desk?: DeskBrief | null;
  trades?: SuggestedTrades | null;
}

type CopilotData = Record<string, unknown> & {
  status: { status: string };
  scope: { locked: boolean };
};

type CopilotMessage = UIMessage<CopilotMetadata, CopilotData>;
type SqlValue = string | number | boolean | null;

const QUESTION_MAX_CHARS = 4_000;
const HISTORY_MESSAGES_MAX = 16;
const HISTORY_MESSAGE_MAX_CHARS = 6_000;
const HISTORY_CHARS_DEFAULT = 48_000;
const OUTPUT_TOKENS_DEFAULT = 8_192;
const OUTPUT_TOKENS_MAX = 16_384;
const TOOL_ROUND_TOKENS_MAX = 2_048;
const FINAL_TOKEN_RESERVE = 1_024;
const FRAME_TTL_MS = 15 * 60_000;
const MAX_FRAMES = 8;
const MAX_FRAME_ROWS = 100_000;
const RESULT_PERSIST_MAX_ROWS = 200;
const CONVERSATION_RETENTION_DAYS = 30;

/** @deprecated Prefer COPILOT_TOOL_LABELS from copilot-contract — kept for existing imports. */
export const TOOL_LABELS: Record<string, string> = { ...COPILOT_TOOL_LABELS };

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), max) : fallback;
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
  protected abstract researchTicker(symbol: string, opts?: { force?: boolean; chatId?: string }): Promise<ResearchToolResult>;

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
      failed_query_count INTEGER NOT NULL DEFAULT 0,
      capture_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Existing Durable Object SQLite instances created before failed_query_count
    // shipped need the column added in place.
    const turnBudgetCols = this.sql<{ name: string }>`PRAGMA table_info(copilot_turn_budget)`.map((row) => row.name);
    if (!turnBudgetCols.includes("failed_query_count")) {
      this.sql`ALTER TABLE copilot_turn_budget ADD COLUMN failed_query_count INTEGER NOT NULL DEFAULT 0`;
    }
    // Once an off-topic turn is rejected, the chat stays locked so follow-up
    // jailbreak retries cannot re-enter the agent loop on this instance.
    this.sql`CREATE TABLE IF NOT EXISTS bot_session (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      persona TEXT NOT NULL,
      system_prompt_extra TEXT NOT NULL,
      model TEXT,
      reasoning_effort TEXT,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS copilot_scope_lock (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      locked INTEGER NOT NULL,
      locked_at INTEGER NOT NULL
    )`;
  }

  private isScopeLocked(): boolean {
    this.ensureCopilotSchema();
    const row = this.sql<{ locked: number }>`
      SELECT locked FROM copilot_scope_lock WHERE singleton = 1 LIMIT 1
    `[0];
    return row?.locked === 1;
  }

  private lockScope(): void {
    this.ensureCopilotSchema();
    this.sql`
      INSERT OR REPLACE INTO copilot_scope_lock (singleton, locked, locked_at)
      VALUES (1, 1, ${Date.now()})
    `;
  }

  private scopeRejectedResponse(originalMessages: CopilotMessage[]): Response {
    // MUST complete a normal assistant turn (start → text → finish), never
    // `{ type: "error" }`. An error chunk leaves the leaf as the user message,
    // and chatRecovery treats that as a lost-partial turn and retries forever.
    const messageId = crypto.randomUUID();
    const textId = crypto.randomUUID();
    const stream = createUIMessageStream<CopilotMessage>({
      originalMessages,
      execute: ({ writer }) => {
        writer.write({ type: "data-scope", data: { locked: true }, transient: true });
        writer.write({ type: "start", messageId });
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: SCOPE_REJECTED_ERROR });
        writer.write({ type: "text-end", id: textId });
        writer.write({
          type: "finish",
          messageMetadata: { model: "", createdAt: Date.now(), scopeRejected: true },
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  @callable()
  async getScopeLock(): Promise<{ locked: boolean }> {
    return { locked: this.isScopeLocked() };
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

  private cacheQueryFrame(result: QueryResult, sql: string, saveAs?: string): string[] {
    if (result.row_count <= 0) return [];
    this.saveFrame(LAST_FRAME_NAME, result.columns, result.rows, sql);
    if (saveAs && saveAs !== LAST_FRAME_NAME) this.saveFrame(saveAs, result.columns, result.rows, sql);
    const alias = saveAs && saveAs !== LAST_FRAME_NAME ? ` Alias '${saveAs}'.` : "";
    return [`Cached as frame '${LAST_FRAME_NAME}' (${result.row_count} rows).${alias}`];
  }

  @callable()
  async getFrameMetadata(): Promise<FrameMetadata[]> {
    this.ensureCopilotSchema();
    return this.frameMetadata();
  }

  /**
   * Latest turn-budget capture (sql/result/chart/desk/trades). Interactive share and
   * post-turn UI reconcile against this when message parts omit tool outputs
   * after recovery / stream abort.
   */
  @callable()
  async getTurnCapture(): Promise<ShareCapture | null> {
    this.ensureCopilotSchema();
    try {
      const budget = this.readTurnBudget();
      const raw = JSON.parse(budget.capture_json) as ShareCapture;
      const desk = raw.desk ? normalizeDeskBrief(raw.desk) : null;
      const trades = raw.trades ? normalizeSuggestedTrades(raw.trades) : null;
      return {
        sql: typeof raw.sql === "string" ? raw.sql : null,
        result: raw.result ?? null,
        chart: raw.chart ?? null,
        desk,
        trades,
      };
    } catch {
      return null;
    }
  }

  /** Bind this conversation to an enabled bot persona (admin generate / trigger). */
  @callable()
  async setBotProfile(profile: {
    handle: string;
    display_name: string;
    persona: string;
    system_prompt_extra?: string;
    model?: string | null;
    reasoning_effort?: string | null;
  }): Promise<{ ok: true; handle: string }> {
    this.ensureCopilotSchema();
    const handle = String(profile.handle ?? "").trim().toLowerCase();
    const display_name = String(profile.display_name ?? "").trim();
    const persona = String(profile.persona ?? "").trim();
    if (!handle || !display_name || !persona) throw new Error("handle, display_name, and persona are required");
    this.sql`
      INSERT OR REPLACE INTO bot_session
        (singleton, handle, display_name, persona, system_prompt_extra, model, reasoning_effort, updated_at)
      VALUES (
        1,
        ${handle},
        ${display_name},
        ${persona},
        ${String(profile.system_prompt_extra ?? "")},
        ${profile.model ? String(profile.model) : null},
        ${profile.reasoning_effort ? String(profile.reasoning_effort) : null},
        ${Date.now()}
      )
    `;
    return { ok: true, handle };
  }

  /**
   * Headless bot turn for schedules / server triggers.
   * Sets the persona, runs one user prompt via saveMessages, returns share-ready turns.
   */
  async runHeadlessBotTurn(input: {
    prompt: string;
    bot: {
      handle: string;
      display_name: string;
      persona: string;
      system_prompt_extra?: string;
      model?: string | null;
      reasoning_effort?: string | null;
    };
  }): Promise<{
    status: "completed" | "error" | "skipped" | "aborted";
    error?: string;
    model: string | null;
    messages: ShareTurn[];
  }> {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return { status: "error", error: "prompt is required", model: null, messages: [] };
    await this.setBotProfile(input.bot);
    const userMessage: UIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: prompt }],
    };
    const result = await this.saveMessages((current) => [...current, userMessage]);
    let messages = extractShareTurns(this.messages as UIMessage[]);
    // Parts can omit tool outputs after a headless run; turn-budget capture is
    // the source of truth for the sql/result/chart the tools just produced.
    try {
      const budget = this.readTurnBudget();
      const capture = JSON.parse(budget.capture_json) as ShareCapture;
      messages = applyCaptureToShareTurns(messages, capture, prompt);
    } catch {
      // No turn budget yet (failed before tools) — keep part-derived turns.
    }
    const model = [...messages].reverse().find((m) => m.role === "assistant")
      ? (input.bot.model?.trim() || this.env.COPILOT_MODEL?.trim() || null)
      : null;
    if (result.status !== "completed") {
      return { status: result.status, error: result.error, model, messages };
    }
    if (!messages.some((m) => m.role === "assistant" && m.content.trim())) {
      return { status: "error", error: "no assistant answer produced", model, messages };
    }
    return { status: "completed", model, messages };
  }

  private readBotSession(): (BotPromptProfile & { model: string | null; reasoning_effort: string | null }) | null {
    this.ensureCopilotSchema();
    const row = this.sql<{
      handle: string;
      display_name: string;
      persona: string;
      system_prompt_extra: string;
      model: string | null;
      reasoning_effort: string | null;
    }>`
      SELECT handle, display_name, persona, system_prompt_extra, model, reasoning_effort
      FROM bot_session WHERE singleton = 1
    `[0];
    return row ?? null;
  }

  private async resolveBotProfile(options: OnChatMessageOptions): Promise<(BotPromptProfile & { model: string | null; reasoning_effort: string | null }) | null> {
    const stashed = this.readBotSession();
    if (stashed) return stashed;
    const handleRaw = typeof options.body?.bot_handle === "string" ? options.body.bot_handle.trim().toLowerCase() : "";
    if (!handleRaw || !this.env.SCHEMA_DB) return null;
    const row = await this.env.SCHEMA_DB.prepare(
      `SELECT handle, display_name, persona, system_prompt_extra, model, reasoning_effort
       FROM bot_profiles WHERE handle = ?1 AND enabled = 1`,
    ).bind(handleRaw).first<{
      handle: string;
      display_name: string;
      persona: string;
      system_prompt_extra: string;
      model: string | null;
      reasoning_effort: string | null;
    }>();
    if (!row) return null;
    // Persist so reconnects / continuations keep the persona without re-querying.
    this.sql`
      INSERT OR REPLACE INTO bot_session
        (singleton, handle, display_name, persona, system_prompt_extra, model, reasoning_effort, updated_at)
      VALUES (
        1,
        ${row.handle},
        ${row.display_name},
        ${row.persona},
        ${row.system_prompt_extra},
        ${row.model},
        ${row.reasoning_effort},
        ${Date.now()}
      )
    `;
    return row;
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
        return formatColumnSketch(column, sketch, true);
      }).join(", ");
      return `- '${frame.name}': ${frame.row_count} rows × ${columns.length} cols, age ${age < 1 ? "<1" : age} min — ${columnSummary}`;
    }).join("\n").slice(0, MAX_TOOL_SUMMARY_CHARS);
  }

  private filterFrame(frame: StoredFrame, args: FrameQueryArgs): QueryResult {
    const compiled = compileFrameQuery(frame.columns, frame.name, args);
    const rows = this.dynamicSql<{ row_json: string }>(compiled.sql, compiled.values).map((row) => JSON.parse(row.row_json) as Record<string, unknown>);
    return { columns: compiled.columns, rows, row_count: rows.length, truncated: false, limit: rows.length };
  }

  private resetTurnBudget(turnId: string, total: number): Capture {
    const capture: Capture = { sql: null, result: null, chart: null, desk: null, trades: null };
    this.sql`
      INSERT OR REPLACE INTO copilot_turn_budget
        (singleton, turn_id, used_output_tokens, total_output_tokens, successful_query, failed_query_count, capture_json, updated_at)
      VALUES (1, ${turnId}, 0, ${total}, 0, 0, ${JSON.stringify(capture)}, ${Date.now()})
    `;
    return capture;
  }

  private readTurnBudget(): {
    turn_id: string;
    used_output_tokens: number;
    total_output_tokens: number;
    successful_query: number;
    failed_query_count: number;
    capture_json: string;
  } {
    const row = this.sql<{
      turn_id: string;
      used_output_tokens: number;
      total_output_tokens: number;
      successful_query: number;
      failed_query_count: number | null;
      capture_json: string;
    }>`
      SELECT turn_id, used_output_tokens, total_output_tokens, successful_query, failed_query_count, capture_json
      FROM copilot_turn_budget WHERE singleton = 1
    `[0];
    if (!row) throw new Error("Copilot turn budget is unavailable.");
    return { ...row, failed_query_count: row.failed_query_count ?? 0 };
  }

  private writeTurnState(
    usedOutputTokens: number,
    successfulQuery: boolean,
    failedQueryCount: number,
    capture: Capture,
  ): void {
    this.sql`
      UPDATE copilot_turn_budget SET
        used_output_tokens = ${usedOutputTokens},
        successful_query = ${successfulQuery ? 1 : 0},
        failed_query_count = ${failedQueryCount},
        capture_json = ${JSON.stringify(capture)},
        updated_at = ${Date.now()}
      WHERE singleton = 1
    `;
  }

  private setCapturedResult(capture: Capture, result: QueryResult, sql: string): void {
    capture.sql = sql;
    capture.result = result;
    if (capture.chart && (!result.columns.length || !chartFitsResult(capture.chart, result.columns))) {
      capture.chart = null;
    }
  }

  private output(ok: boolean, summary: string, extra: Pick<ToolOutput, "error" | "issues" | "sql" | "result" | "chart" | "frames" | "research" | "desk" | "trades"> = {}): ToolOutput {
    return {
      ok,
      summary: summary.slice(0, MAX_TOOL_SUMMARY_CHARS),
      error: extra.error,
      issues: extra.issues,
      ...(extra.sql !== undefined ? { sql: extra.sql } : {}),
      ...(extra.result !== undefined ? { result: boundedResult(extra.result) } : {}),
      ...(extra.chart !== undefined ? { chart: extra.chart } : {}),
      ...(extra.frames !== undefined ? { frames: extra.frames.slice(0, MAX_FRAMES) } : {}),
      ...(extra.desk !== undefined ? { desk: extra.desk } : {}),
      ...(extra.trades !== undefined ? { trades: extra.trades } : {}),
    };
  }

  /** Append one tool outcome to D1 for admin debugging. Never blocks the model loop. */
  private recordToolEvent(toolName: string, args: unknown, output: ToolOutput, durationMs: number): void {
    const chatId = typeof this.name === "string" ? this.name : "";
    if (!chatId || !this.env.SCHEMA_DB) return;
    let turnId = "unknown";
    try {
      turnId = this.readTurnBudget().turn_id;
    } catch {
      // Turn budget may not be initialized yet — still record with a placeholder.
    }
    const eventId = crypto.randomUUID();
    const model = typeof this.env.COPILOT_MODEL === "string" ? this.env.COPILOT_MODEL : null;
    this.ctx.waitUntil(
      insertToolEvent(this.env.SCHEMA_DB, {
        event_id: eventId,
        chat_id: chatId,
        turn_id: turnId,
        tool_name: toolName,
        ok: output.ok,
        args,
        error: output.error ?? null,
        summary: output.summary,
        sql: output.sql ?? null,
        duration_ms: durationMs,
        model,
      }),
    );
  }

  private async safeTool(
    toolName: string,
    label: string,
    args: unknown,
    capture: Capture,
    operation: () => Promise<ToolOutput> | ToolOutput,
  ): Promise<ToolOutput> {
    const started = Date.now();
    let output: ToolOutput;
    try {
      output = await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output = this.output(false, `${label} failed: ${message}`, { error: message });
    }
    this.recordToolEvent(toolName, args, output, Date.now() - started);
    return output;
  }

  private createTools(
    tables: LakeTable[],
    capture: Capture,
    status: (value: string) => void,
    turn: { used: number; successfulQuery: boolean; failedQueryCount: number },
  ) {
    const persist = () => this.writeTurnState(turn.used, turn.successfulQuery, turn.failedQueryCount, capture);
    const noteQueryFailure = () => {
      turn.failedQueryCount += 1;
      persist();
    };
    return {
      run_query: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.run_query,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.run_query,
        execute: async ({ sql, save_as }) => this.safeTool("run_query", TOOL_LABELS.run_query, { sql, save_as }, capture, async () => {
          const normalized = applyColumnSynonyms(sql, tables);
          const issues = validateSqlSchema(normalized.sql, tables);
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length) {
            const message = errors.map((issue) => issue.message).join(" ");
            noteQueryFailure();
            return this.output(false, `Schema validation failed: ${message}`, { error: message });
          }
          status("Running query…");
          const result = await this.executeLakeQuery(normalized.sql, FRAME_QUERY_LIMIT);
          this.setCapturedResult(capture, result, normalized.sql);
          if (result.error) {
            noteQueryFailure();
            return this.output(false, `Query failed: ${result.error}`, { error: result.error, sql: normalized.sql, result });
          }
          turn.successfulQuery = true;
          turn.failedQueryCount = 0;
          const cached = this.cacheQueryFrame(result, normalized.sql, save_as);
          persist();
          const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
          const synonymNote = normalized.rewrites.length
            ? [`Column synonyms applied: ${normalized.rewrites.join("; ")}`]
            : [];
          const summary = summarizeResult(result, [...synonymNote, ...(warnings.length ? [`Schema notes: ${warnings.join(" ")}`] : []), ...cached]);
          return this.output(true, summary, { error: null, sql: normalized.sql, result, frames: this.frameMetadata() });
        }),
      }),
      check_schema: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.check_schema,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.check_schema,
        execute: async ({ sql }) => this.safeTool("check_schema", TOOL_LABELS.check_schema, { sql }, capture, () => {
          const normalized = applyColumnSynonyms(sql, tables);
          const issues = validateSqlSchema(normalized.sql, tables).map((issue) => `[${issue.severity}] ${issue.message}`);
          if (normalized.rewrites.length) {
            issues.unshift(`[info] Column synonyms applied: ${normalized.rewrites.join("; ")}`);
          }
          return this.output(issues.every((issue) => !issue.startsWith("[error]")), issues.join("\n") || "SQL matches the current schema.", { issues, sql: normalized.sql });
        }),
      }),
      list_frames: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.list_frames,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.list_frames,
        execute: async () => this.safeTool("list_frames", TOOL_LABELS.list_frames, {}, capture, () => this.output(true, this.frameCatalog(), { error: null, frames: this.frameMetadata() })),
      }),
      filter_frame: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.filter_frame,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.filter_frame,
        execute: async (args) => this.safeTool("filter_frame", TOOL_LABELS.filter_frame, args, capture, () => {
          const frame = this.getFrame(args.frame);
          if (!frame) return this.output(false, `No cached frame '${args.frame}'.`, { error: `No frame '${args.frame}'.` });
          if (Date.now() - frame.fetched_at > FRAME_TTL_MS) {
            return this.output(false, `Frame '${args.frame}' is stale. Call refresh_frame and retry.`, { error: `Frame '${args.frame}' is stale.` });
          }
          const reducing = Boolean(args.aggregations?.length);
          status(reducing ? "Reducing cached data…" : "Filtering cached data…");
          const result = this.filterFrame(frame, args);
          const sliceSql = `-- ${reducing ? "reduction" : "slice"} of cached frame '${frame.name}'\n-- source: ${frame.sql}`;
          this.setCapturedResult(capture, result, sliceSql);
          turn.successfulQuery = true;
          turn.failedQueryCount = 0;
          if (args.save_as && result.row_count > 0) this.saveFrame(args.save_as, result.columns, result.rows, frame.sql);
          persist();
          const notes = args.save_as ? [`Saved frame '${args.save_as}'.`] : [];
          return this.output(true, summarizeResult(result, notes), { error: null, sql: sliceSql, result, frames: this.frameMetadata() });
        }),
      }),
      refresh_frame: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.refresh_frame,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.refresh_frame,
        execute: async ({ frame: name }) => this.safeTool("refresh_frame", TOOL_LABELS.refresh_frame, { frame: name }, capture, async () => {
          const frame = this.getFrame(name);
          if (!frame) return this.output(false, `No cached frame '${name}'.`, { error: `No frame '${name}'.` });
          status("Refreshing cached data…");
          const result = await this.executeLakeQuery(frame.sql, FRAME_QUERY_LIMIT);
          this.setCapturedResult(capture, result, frame.sql);
          if (result.error) {
            turn.failedQueryCount += 1;
            persist();
            return this.output(false, `Refresh failed: ${result.error}`, { error: result.error, sql: frame.sql, result });
          }
          turn.successfulQuery = true;
          turn.failedQueryCount = 0;
          if (result.row_count > 0) this.saveFrame(name, result.columns, result.rows, frame.sql);
          persist();
          return this.output(true, summarizeResult(result, [`Refreshed frame '${name}' (${result.row_count} rows).`]), { error: null, sql: frame.sql, result, frames: this.frameMetadata() });
        }),
      }),
      render_chart: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.render_chart,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.render_chart,
        execute: async (args) => this.safeTool("render_chart", TOOL_LABELS.render_chart, args, capture, () => {
          const result = capture.result;
          if (!result || result.error) return this.output(false, "No successful result to chart.", { error: "No successful result to chart." });
          const x = resolveColumn(result.columns, args.x);
          const y = resolveColumn(result.columns, args.y);
          if (!x || !y) {
            const error = `Result lacks '${args.x}' or '${args.y}'. Available columns: ${result.columns.join(", ")}.`;
            return this.output(false, error, { error });
          }
          const series = args.series ? resolveColumn(result.columns, args.series) ?? undefined : undefined;
          capture.chart = {
            kind: args.kind,
            x,
            y,
            ...(args.title ? { title: args.title } : {}),
            ...(series ? { series } : {}),
            ...(args.xLabel ? { xLabel: args.xLabel } : {}),
            ...(args.yLabel ? { yLabel: args.yLabel } : {}),
          };
          persist();
          // Include sql+result so the client can plot even if it only reads the
          // last tool output (render_chart used to return chart-only and wiped
          // the rows the Recharts view needs).
          return this.output(true, "Chart specification validated.", {
            error: null,
            sql: capture.sql,
            result,
            chart: capture.chart,
            frames: this.frameMetadata(),
          });
        }),
      }),
      get_news: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.get_news,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_news,
        execute: async ({ symbol, limit }) => this.safeTool("get_news", TOOL_LABELS.get_news, { symbol, limit }, capture, async () => {
          const result = await this.fetchNews(symbol.toUpperCase(), limit);
          if (result.error) return this.output(false, `News temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No recent headlines found for ${result.symbol}.`;
          return this.output(true, summary, { error: null });
        }),
      }),
      web_search: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.web_search,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.web_search,
        execute: async ({ query, max_results }) => this.safeTool("web_search", TOOL_LABELS.web_search, { query, max_results }, capture, async () => {
          const result = await this.searchWeb(query, max_results);
          if (result.error) return this.output(false, `Web search temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.results.length ? result.results.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No results found for "${result.query}".`;
          return this.output(true, summary, { error: null });
        }),
      }),
      eco_calendar: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.eco_calendar,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.eco_calendar,
        execute: async ({ days }) => this.safeTool("eco_calendar", TOOL_LABELS.eco_calendar, { days }, capture, async () => {
          const result = await this.fetchEconomicCalendar(days);
          if (result.error) return this.output(false, `Macro calendar temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`).join("\n") : "No scheduled macro events in the requested window.";
          return this.output(true, summary, { error: null });
        }),
      }),
      research_ticker: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.research_ticker,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.research_ticker,
        execute: async ({ symbol, force }) => this.safeTool("research_ticker", TOOL_LABELS.research_ticker, { symbol, force }, capture, async () => {
          const chatId = typeof this.name === "string" ? this.name : undefined;
          const result = await this.researchTicker(symbol, { force, chatId });
          if (result.error && !result.research) {
            return this.output(false, `Research unavailable: ${result.error}`, { error: result.error });
          }
          return this.output(true, result.summary, {
            error: result.error ?? null,
            research: result.research ?? null,
          });
        }),
      }),
      publish_desk: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.publish_desk,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.publish_desk,
        execute: async (args) => this.safeTool("publish_desk", TOOL_LABELS.publish_desk, args, capture, () => {
          status("Publishing desk viewpoints…");
          const desk = normalizeDeskBrief(args);
          if (!desk) {
            return this.output(false, "publish_desk requires non-empty fundamental, technical, options, and overview fields.", {
              error: "Desk viewpoints incomplete.",
            });
          }
          capture.desk = desk;
          persist();
          return this.output(true, formatDeskToolSummary(desk), { error: null, desk });
        }),
      }),
      suggest_trades: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.suggest_trades,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.suggest_trades,
        execute: async (args) => this.safeTool("suggest_trades", TOOL_LABELS.suggest_trades, args, capture, () => {
          status("Publishing suggested trades…");
          const trades = normalizeSuggestedTrades(args);
          if (!trades) {
            return this.output(false, "suggest_trades requires 1–3 trades, or trades: [] with skip_reason.", {
              error: "Suggested trades incomplete.",
            });
          }
          capture.trades = trades;
          persist();
          return this.output(true, formatTradesToolSummary(trades), { error: null, trades });
        }),
      }),
    };
  }

  override async onChatMessage(_onFinish: unknown, options: OnChatMessageOptions): Promise<Response> {
    this.ensureCopilotSchema();
    this.cleanupRetention();
    if (this.env.SCHEMA_DB) {
      this.ctx.waitUntil(purgeExpiredToolEvents(this.env.SCHEMA_DB));
    }
    if (!this.env.COPILOT_MODEL?.trim()) return Response.json({ error: "COPILOT_MODEL is not configured" }, { status: 503 });
    if (!this.env.OPEN_ROUTER_KEY?.trim()) return Response.json({ error: "Copilot is not configured" }, { status: 503 });

    const originalMessages = this.messages as CopilotMessage[];
    if (this.isScopeLocked()) {
      return this.scopeRejectedResponse(originalMessages);
    }

    const totalBudget = positiveInt(this.env.COPILOT_MAX_OUTPUT_TOKENS, OUTPUT_TOKENS_DEFAULT, OUTPUT_TOKENS_MAX);
    if (!options.continuation) this.resetTurnBudget(options.requestId, totalBudget);
    const budget = this.readTurnBudget();
    const capture = {
      desk: null as DeskBrief | null,
      trades: null as SuggestedTrades | null,
      ...(JSON.parse(budget.capture_json) as Partial<Capture>),
    } as Capture;
    if (!capture.desk) capture.desk = null;
    if (!capture.trades) capture.trades = null;
    const turn = {
      used: budget.used_output_tokens,
      successfulQuery: budget.successful_query === 1,
      failedQueryCount: budget.failed_query_count,
    };
    this.stash({ turnId: budget.turn_id, usedOutputTokens: turn.used });

    const historyCharsMax = positiveInt(this.env.COPILOT_MAX_HISTORY_CHARS, HISTORY_CHARS_DEFAULT, HISTORY_CHARS_DEFAULT);
    let messages: ModelMessage[];
    try {
      messages = boundedMessages(this.messages, historyCharsMax);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorStream = createUIMessageStream<CopilotMessage>({
        originalMessages,
        execute: ({ writer }) => writer.write({ type: "error", errorText: message }),
      });
      return createUIMessageStreamResponse({ stream: errorStream });
    }

    const originValue = typeof options.body?.origin === "string" ? options.body.origin : "";
    const origin = /^https?:\/\//.test(originValue) ? originValue : "https://robs-options-slop-dev.pages.dev";
    const bot = await this.resolveBotProfile(options);
    const modelEnv = bot?.model
      ? { ...this.env, COPILOT_MODEL: bot.model }
      : this.env;
    const reasoningEffort = bot?.reasoning_effort || this.env.COPILOT_REASONING_EFFORT;
    const model = createCopilotModel(modelEnv, origin);

    // Pre-agent finance gate: reject off-topic turns with a hard error (no
    // assistant prose) and lock the chat so jailbreak follow-ups cannot retry.
    if (!options.continuation) {
      const question = latestUserText(this.messages);
      const decision = await classifyFinanceScope(question, model, { abortSignal: options.abortSignal });
      if (!decision.inScope) {
        this.lockScope();
        console.log(JSON.stringify({
          copilotScope: true,
          rejected: true,
          questionChars: question.length,
        }));
        return this.scopeRejectedResponse(originalMessages);
      }
    }

    const tables = await this.loadSchema();
    const latestQuestion = latestUserText(this.messages).toLowerCase();
    const requestedFrame = this.frameMetadata().find((frame) => latestQuestion.includes(frame.name.toLowerCase()));
    let wroteAnswerStatus = false;
    const activeModel = bot?.model || this.env.COPILOT_MODEL;

    const stream = createUIMessageStream<CopilotMessage>({
      originalMessages,
      onError: (error) => error instanceof Error ? error.message : String(error),
      execute: ({ writer }) => {
        const status = (value: string) => writer.write({ type: "data-status", data: { status: value }, transient: true });
        status("Reasoning over the data…");
        const tools = this.createTools(tables, capture, status, turn);
        const result = streamText({
          model,
          system: systemPrompt(schemaToPrompt(tables), bot),
          messages,
          tools,
          stopWhen: isStepCount(AGENT_ITERATIONS_MAX),
          abortSignal: options.abortSignal,
          providerOptions: {
            openrouter: { reasoning: { effort: normalizeReasoningEffort(reasoningEffort) } },
          },
          prepareStep: ({ stepNumber }) => {
            const policy = nextCopilotStepPolicy({
              stepNumber,
              remainingTokens: budget.total_output_tokens - turn.used,
              successfulQuery: turn.successfulQuery,
              failedQueryCount: turn.failedQueryCount,
              preferFilterFrame: Boolean(requestedFrame),
              toolRoundTokensMax: TOOL_ROUND_TOKENS_MAX,
              finalTokenReserve: FINAL_TOKEN_RESERVE,
              // Timeline bots keep a single persona voice; interactive chat always
              // publishes the three-analyst desk + structured trades once lake evidence exists.
              requireDesk: !bot,
              deskPublished: Boolean(capture.desk),
              requireTrades: !bot,
              tradesPublished: capture.trades != null,
            });
            return policy;
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
            this.writeTurnState(turn.used, turn.successfulQuery, turn.failedQueryCount, capture);
          },
          onFinish: () => {
            console.log(JSON.stringify({
              copilotChat: true,
              model: activeModel,
              botHandle: bot?.handle ?? null,
              outputTokens: turn.used,
              failedQueryCount: turn.failedQueryCount,
              toolsProducedResult: capture.result !== null,
            }));
          },
        });
        writer.merge(result.toUIMessageStream<CopilotMessage>({
          sendReasoning: true,
          messageMetadata: ({ part }) => {
            if (part.type !== "finish") return undefined;
            return {
              model: activeModel,
              createdAt: Date.now(),
              ...(capture.sql ? { sql: capture.sql } : {}),
              ...(capture.result ? { result: boundedResult(capture.result) } : {}),
              ...(capture.chart ? { chart: capture.chart } : {}),
              ...(capture.desk ? { desk: capture.desk } : {}),
              ...(capture.trades ? { trades: capture.trades } : {}),
            };
          },
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
            ...(output.chart !== undefined ? { chart: output.chart } : {}),
            ...(output.frames !== undefined ? { frames: output.frames.slice(0, MAX_FRAMES) } : {}),
            ...(output.desk !== undefined ? { desk: output.desk } : {}),
            ...(output.trades !== undefined ? { trades: output.trades } : {}),
          },
        };
      }),
    };
  }
}
