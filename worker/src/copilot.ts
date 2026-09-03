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
import { formatDeskToolSummary, normalizeDeskBrief, type DeskBrief, type DeskBriefInput, type DeskViewpointId } from "./copilot-desk";
import { selectDeskSpecialists } from "./copilot-desk-route";
import { formatTradesToolSummary, normalizeSuggestedTrades, type SuggestedTrades } from "./copilot-trades";
import { formatPaperPortfolioSummary } from "./paper-portfolio";
import { formatBotTradesSummary } from "./bot-trades";
import { formatSchwabQuotesSummary, sanitizeQuoteSymbols } from "./schwab-marketdata";
import { formatSymbolIdentities, lookupSymbolIdentities, type SymbolIdentity } from "./symbol-identity";
import { filterSchwabPortfolioView, formatSchwabPortfolioSummary } from "./schwab-portfolio";
import { schemaToPrompt, systemPrompt, type BotPromptProfile } from "./copilot-prompt";
import { parseReplyPrefFromBody } from "./reply-style";
import { extractShareTurns, applyCaptureToShareTurns, type ShareCapture, type ShareTurn } from "./share-turns";
import { looksLikeDsmlToolMarkup, parseDsmlToolCalls } from "./dsml";
import { stripLeakedToolMarkup } from "./tool-markup";

export type { BotPromptProfile } from "./copilot-prompt";
export { SCHEMA_PLACEHOLDER, schemaToPrompt, systemPrompt } from "./copilot-prompt";

function parseBotSessionAccountFilter(raw: string | null | undefined): string | string[] | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return null;
      const ids = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      return ids.length ? ids : null;
    } catch {
      return null;
    }
  }
  return value;
}
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
  /** In-turn counter: failed suggest_trades while forcing (persisted in capture_json). */
  failed_trades_count?: number;
  /** In-turn counter: failed publish_desk while forcing (stub rejection, etc.). */
  failed_desk_count?: number;
  /** Steps completed after the first successful lake query (desk gather window). */
  steps_after_query?: number;
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
  /**
   * Multi-analyst desk turns (research + lake SQL + publish_desk + suggest_trades
   * under high reasoning) routinely leave multi-minute gaps between stream
   * chunks. Invalid legacy fields (maxAgeMs / noProgressLimit) were ignored by
   * the SDK; tune the real budgets so a healthy desk turn is not aborted into
   * chatRecovery — each retry was landing as another empty assistant bubble
   * (see share 1e79caJg9cECVL7jW06PUerj4).
   */
  override chatRecovery = {
    maxAttempts: 6,
    stableTimeoutMs: 15_000,
    noProgressTimeoutMs: 10 * 60_000,
    maxRecoveryWork: Number.POSITIVE_INFINITY,
    terminalMessage: "The assistant was interrupted and could not recover this turn.",
  };
  /** Stall watchdog: gap between chunks, not total turn length. Keep above
   *  slowest legitimate quiet period (OpenRouter high-reasoning + research_ticker). */
  override chatStreamStallTimeoutMs = 5 * 60_000;

  protected abstract loadSchema(): Promise<LakeTable[]>;
  protected abstract executeLakeQuery(sql: string, limit: number): Promise<QueryResult>;
  protected abstract fetchNews(symbol: string, limit: number): Promise<NewsResult>;
  protected abstract searchWeb(query: string, limit: number): Promise<SearchResult>;
  protected abstract fetchEconomicCalendar(days: number): Promise<CalendarResult>;
  protected abstract researchTicker(symbol: string, opts?: { force?: boolean; chatId?: string }): Promise<ResearchToolResult>;

  /** Identify tickers (ETF vs equity vs …) when lake coverage is missing. */
  protected lookupSymbols(symbols: string[]): Promise<SymbolIdentity[]> {
    return lookupSymbolIdentities(symbols);
  }

  /**
   * Apply suggest_trades into the chat owner's paper portfolio (lake marks).
   * Default no-op — concrete Worker overrides with SCHEMA_DB + R2 SQL.
   */
  protected autoTrackSuggestedTrades(
    _trades: SuggestedTrades,
  ): Promise<import("./paper-portfolio").AutoTrackResult | null> {
    return Promise.resolve(null);
  }

  /**
   * Snapshot suggest_trades into a bot performance book when this DO is a bot.
   * Default no-op — Worker overrides when bot_session is set.
   */
  protected autoTrackBotSuggestedTrades(
    _trades: SuggestedTrades,
  ): Promise<import("./bot-trades").BotTrackResult | null> {
    return Promise.resolve(null);
  }

  /**
   * Load the chat owner's paper book for get_paper_portfolio.
   * Default null = tool unavailable (tests / no lake binding).
   */
  protected loadPaperPortfolio(
    _status: "open" | "closed" | "all",
    _conviction?: "high" | "medium" | "low" | null,
  ): Promise<import("./paper-portfolio").PaperPortfolioView | null> {
    return Promise.resolve(null);
  }

  /**
   * Load a public bot suggested-trade book for get_bot_trades.
   * Default null = tool unavailable (tests / no lake binding).
   */
  protected loadBotTrades(
    _handle: string,
    _status: "open" | "closed" | "all",
    _conviction?: "high" | "medium" | "low" | null,
  ): Promise<import("./bot-trades").BotTradesBook | null> {
    return Promise.resolve(null);
  }

  /**
   * Load the chat owner's linked Schwab book for get_schwab_portfolio.
   * Default null = tool unavailable (tests / no Schwab binding).
   */
  protected loadSchwabPortfolio(): Promise<
    | { ok: true; view: import("./schwab-portfolio").SchwabPortfolioView }
    | { ok: false; reason: "not_connected" | "no_owner" | "refresh_failed" | "upstream"; message?: string }
    | null
  > {
    return Promise.resolve(null);
  }

  /**
   * Live Schwab quotes for get_schwab_quotes. Owner is resolved by the
   * subclass — this hook never receives a user id from the model.
   */
  protected loadSchwabQuotes(_symbols: string[]): Promise<
    | { ok: true; quotes: import("./schwab-marketdata").SchwabQuote[] }
    | { ok: false; reason: "not_connected" | "no_owner" | "refresh_failed" | "upstream" | "no_symbols"; message?: string }
    | null
  > {
    return Promise.resolve(null);
  }

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
      audience TEXT NOT NULL DEFAULT 'public',
      attach_portfolio INTEGER NOT NULL DEFAULT 0,
      publish_to_timeline INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`;
    const botSessionCols = this.sql<{ name: string }>`PRAGMA table_info(bot_session)`.map((row) => row.name);
    if (!botSessionCols.includes("audience")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN audience TEXT NOT NULL DEFAULT 'public'`;
    }
    if (!botSessionCols.includes("attach_portfolio")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN attach_portfolio INTEGER NOT NULL DEFAULT 0`;
    }
    if (!botSessionCols.includes("publish_to_timeline")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN publish_to_timeline INTEGER NOT NULL DEFAULT 1`;
    }
    if (!botSessionCols.includes("portfolio_source")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN portfolio_source TEXT`;
    }
    if (!botSessionCols.includes("portfolio_account_id")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN portfolio_account_id TEXT`;
    }
    if (!botSessionCols.includes("portfolio_label")) {
      this.sql`ALTER TABLE bot_session ADD COLUMN portfolio_label TEXT`;
    }
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
    audience?: "public" | "private";
    attach_portfolio?: boolean;
    portfolio_source?: "none" | "paper" | "schwab" | "all";
    portfolio_account_id?: string | null;
    portfolio_label?: string | null;
    publish_to_timeline?: boolean;
  }): Promise<{ ok: true; handle: string }> {
    this.ensureCopilotSchema();
    const handle = String(profile.handle ?? "").trim().toLowerCase();
    const display_name = String(profile.display_name ?? "").trim();
    const persona = String(profile.persona ?? "").trim();
    if (!handle || !display_name || !persona) throw new Error("handle, display_name, and persona are required");
    const audience = profile.audience === "private" ? "private" : "public";
    const source = profile.portfolio_source
      ?? (profile.attach_portfolio ? "all" : (audience === "private" ? "none" : undefined));
    const attach = source ? (source === "none" ? 0 : 1) : (profile.attach_portfolio ? 1 : 0);
    const publish = profile.publish_to_timeline === true
      ? 1
      : profile.publish_to_timeline === false
        ? 0
        : (audience === "private" ? 0 : 1);
    const accountId = source === "schwab" && profile.portfolio_account_id
      ? String(profile.portfolio_account_id).trim() || null
      : null;
    const label = profile.portfolio_label ? String(profile.portfolio_label).trim() || null : null;
    this.sql`
      INSERT OR REPLACE INTO bot_session
        (singleton, handle, display_name, persona, system_prompt_extra, model, reasoning_effort,
         audience, attach_portfolio, portfolio_source, portfolio_account_id, portfolio_label,
         publish_to_timeline, updated_at)
      VALUES (
        1,
        ${handle},
        ${display_name},
        ${persona},
        ${String(profile.system_prompt_extra ?? "")},
        ${profile.model ? String(profile.model) : null},
        ${profile.reasoning_effort ? String(profile.reasoning_effort) : null},
        ${audience},
        ${attach},
        ${source ?? null},
        ${accountId},
        ${label},
        ${publish},
        ${Date.now()}
      )
    `;
    return { ok: true, handle };
  }

  /**
   * Seed an empty chat from a public share snapshot (timeline follow-up fork).
   * Uses persistMessages so we do not trigger an LLM turn — the client sends
   * the follow-up question after navigating to /chat/{id}.
   */
  async seedTranscript(input: {
    messages: Array<{
      role: "user" | "assistant";
      content: string;
      reasoning?: string;
      sql?: string;
      chart?: unknown;
      desk?: unknown;
      trades?: unknown;
      frames?: unknown;
      ts?: number;
    }>;
  }): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
    const rows = Array.isArray(input?.messages) ? input.messages : [];
    if (rows.length === 0) return { ok: false, error: "messages are required" };
    if ((this.messages as UIMessage[]).length > 0) {
      return { ok: false, error: "chat already has messages" };
    }
    const uiMessages: UIMessage[] = rows.map((turn) => {
      const parts: UIMessage["parts"] = [];
      const reasoning = typeof turn.reasoning === "string" ? turn.reasoning.trim() : "";
      if (reasoning) parts.push({ type: "reasoning", text: reasoning });
      parts.push({
        type: "text",
        text: typeof turn.content === "string" ? turn.content : "",
      });
      const metadata: Record<string, unknown> = {
        model: "",
        createdAt: typeof turn.ts === "number" && Number.isFinite(turn.ts) ? turn.ts : Date.now(),
      };
      if (typeof turn.sql === "string" && turn.sql.trim()) metadata.sql = turn.sql.trim();
      if (turn.chart) metadata.chart = turn.chart;
      if (turn.desk) metadata.desk = turn.desk;
      if (turn.trades) metadata.trades = turn.trades;
      if (Array.isArray(turn.frames) && turn.frames.length) metadata.frames = turn.frames;
      return {
        id: crypto.randomUUID(),
        role: turn.role === "assistant" ? "assistant" : "user",
        parts,
        metadata,
      } as UIMessage;
    });
    await this.persistMessages(uiMessages);
    return { ok: true, count: uiMessages.length };
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
      audience?: "public" | "private";
      attach_portfolio?: boolean;
      portfolio_source?: "none" | "paper" | "schwab" | "all";
      portfolio_account_id?: string | null;
      portfolio_label?: string | null;
      publish_to_timeline?: boolean;
    };
    ownerUserId?: string;
  }): Promise<{
    status: "completed" | "error" | "skipped" | "aborted";
    error?: string;
    model: string | null;
    messages: ShareTurn[];
  }> {
    const prompt = String(input.prompt ?? "").trim();
    if (!prompt) return { status: "error", error: "prompt is required", model: null, messages: [] };
    const ownerUserId = typeof input.ownerUserId === "string" ? input.ownerUserId.trim() : "";
    if (ownerUserId) {
      this.sql`
        CREATE TABLE IF NOT EXISTS paper_session_hint (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          user_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `;
      this.sql`
        INSERT OR REPLACE INTO paper_session_hint (singleton, user_id, updated_at)
        VALUES (1, ${ownerUserId}, ${Date.now()})
      `;
    }
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
      audience: string | null;
      attach_portfolio: number | null;
      portfolio_source: string | null;
      portfolio_account_id: string | null;
      portfolio_label: string | null;
      publish_to_timeline: number | null;
    }>`
      SELECT handle, display_name, persona, system_prompt_extra, model, reasoning_effort,
             audience, attach_portfolio, portfolio_source, portfolio_account_id,
             portfolio_label, publish_to_timeline
      FROM bot_session WHERE singleton = 1
    `[0];
    if (!row) return null;
    const source = row.portfolio_source === "none"
      || row.portfolio_source === "paper"
      || row.portfolio_source === "schwab"
      || row.portfolio_source === "all"
      ? row.portfolio_source
      : undefined;
    return {
      handle: row.handle,
      display_name: row.display_name,
      persona: row.persona,
      system_prompt_extra: row.system_prompt_extra,
      model: row.model,
      reasoning_effort: row.reasoning_effort,
      audience: row.audience === "private" ? "private" : "public",
      attach_portfolio: source ? source !== "none" : row.attach_portfolio === 1,
      portfolio_source: source,
      portfolio_account_id: row.portfolio_account_id,
      portfolio_label: row.portfolio_label,
      publish_to_timeline: row.publish_to_timeline !== 0,
    };
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

  /**
   * Run a tool and keep the UI stream alive. Long quiet tools (research_ticker,
   * lake SQL) previously left no chunks for >chatStreamStallTimeoutMs, which
   * aborted healthy desk turns into chatRecovery and stacked assistant bubbles.
   */
  private async safeTool(
    toolName: string,
    label: string,
    args: unknown,
    capture: Capture,
    operation: () => Promise<ToolOutput> | ToolOutput,
    status?: (value: string) => void,
  ): Promise<ToolOutput> {
    const started = Date.now();
    status?.(`${label}…`);
    let pulse = 0;
    const heartbeat = status
      ? setInterval(() => {
        pulse += 1;
        status(`${label}… (${pulse * 20}s)`);
      }, 20_000)
      : null;
    let output: ToolOutput;
    try {
      output = await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output = this.output(false, `${label} failed: ${message}`, { error: message });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    this.recordToolEvent(toolName, args, output, Date.now() - started);
    return output;
  }

  private createTools(
    tables: LakeTable[],
    capture: Capture,
    status: (value: string) => void,
    turn: {
      used: number;
      successfulQuery: boolean;
      failedQueryCount: number;
      failedTradesCount: number;
      failedDeskCount: number;
      stepsAfterQuery: number;
    },
    deskSpecialists: readonly DeskViewpointId[],
  ) {
    const persist = () => this.writeTurnState(turn.used, turn.successfulQuery, turn.failedQueryCount, capture);
    const noteQueryFailure = () => {
      turn.failedQueryCount += 1;
      persist();
    };
    const noteTradesFailure = () => {
      turn.failedTradesCount += 1;
      capture.failed_trades_count = turn.failedTradesCount;
      persist();
    };
    const noteDeskFailure = () => {
      turn.failedDeskCount += 1;
      capture.failed_desk_count = turn.failedDeskCount;
      persist();
    };
    const runTool = (
      toolName: string,
      label: string,
      args: unknown,
      operation: () => Promise<ToolOutput> | ToolOutput,
    ) => this.safeTool(toolName, label, args, capture, operation, status);
    return {
      run_query: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.run_query,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.run_query,
        execute: async ({ sql, save_as }) => runTool("run_query", TOOL_LABELS.run_query, { sql, save_as }, async () => {
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
        execute: async ({ sql }) => runTool("check_schema", TOOL_LABELS.check_schema, { sql }, () => {
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
        execute: async () => runTool("list_frames", TOOL_LABELS.list_frames, {}, () => this.output(true, this.frameCatalog(), { error: null, frames: this.frameMetadata() })),
      }),
      filter_frame: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.filter_frame,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.filter_frame,
        execute: async (args) => runTool("filter_frame", TOOL_LABELS.filter_frame, args, () => {
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
        execute: async ({ frame: name }) => runTool("refresh_frame", TOOL_LABELS.refresh_frame, { frame: name }, async () => {
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
        execute: async (args) => runTool("render_chart", TOOL_LABELS.render_chart, args, () => {
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
        execute: async ({ symbol, limit }) => runTool("get_news", TOOL_LABELS.get_news, { symbol, limit }, async () => {
          const result = await this.fetchNews(symbol.toUpperCase(), limit);
          if (result.error) return this.output(false, `News temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No recent headlines found for ${result.symbol}.`;
          return this.output(true, summary, { error: null });
        }),
      }),
      web_search: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.web_search,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.web_search,
        execute: async ({ query, max_results }) => runTool("web_search", TOOL_LABELS.web_search, { query, max_results }, async () => {
          const result = await this.searchWeb(query, max_results);
          if (result.error) return this.output(false, `Web search temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.results.length ? result.results.map((item, index) => `${index + 1}. ${item.title} — ${item.link}`).join("\n") : `No results found for "${result.query}".`;
          return this.output(true, summary, { error: null });
        }),
      }),
      eco_calendar: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.eco_calendar,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.eco_calendar,
        execute: async ({ days }) => runTool("eco_calendar", TOOL_LABELS.eco_calendar, { days }, async () => {
          const result = await this.fetchEconomicCalendar(days);
          if (result.error) return this.output(false, `Macro calendar temporarily unavailable: ${result.error}`, { error: result.error });
          const summary = result.items.length ? result.items.map((item, index) => `${index + 1}. ${item.date}${item.time ? ` ${item.time}` : ""} — ${item.title}`).join("\n") : "No scheduled macro events in the requested window.";
          return this.output(true, summary, { error: null });
        }),
      }),
      research_ticker: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.research_ticker,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.research_ticker,
        execute: async ({ symbol, force }) => runTool("research_ticker", TOOL_LABELS.research_ticker, { symbol, force }, async () => {
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
      lookup_symbols: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.lookup_symbols,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.lookup_symbols,
        execute: async ({ symbols }) => runTool("lookup_symbols", TOOL_LABELS.lookup_symbols, { symbols }, async () => {
          status("Identifying symbols and holdings…");
          const rows = await this.lookupSymbols(symbols);
          return this.output(true, formatSymbolIdentities(rows), { error: null });
        }),
      }),
      publish_desk: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.publish_desk,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.publish_desk,
        execute: async (args) => runTool("publish_desk", TOOL_LABELS.publish_desk, args, () => {
          status("Publishing desk viewpoints…");
          const desk = normalizeDeskBrief(args, { required: deskSpecialists });
          if (!desk) {
            noteDeskFailure();
            const needed = deskSpecialists.join("/");
            return this.output(false, `publish_desk rejected: need real ${needed}/overview takes for the active desk (no placeholders or tiny stubs; omit inactive specialists).`, {
              error: "Desk viewpoints incomplete or stubbed.",
            });
          }
          capture.desk = desk;
          capture.failed_desk_count = 0;
          turn.failedDeskCount = 0;
          persist();
          return this.output(true, formatDeskToolSummary(desk), { error: null, desk });
        }),
      }),
      suggest_trades: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.suggest_trades,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.suggest_trades,
        execute: async (args) => runTool("suggest_trades", TOOL_LABELS.suggest_trades, args, async () => {
          status("Publishing suggested trades…");
          const trades = normalizeSuggestedTrades(args);
          if (!trades) {
            noteTradesFailure();
            return this.output(false, "suggest_trades requires a trades array (use [] when there is no lean).", {
              error: "Suggested trades incomplete.",
            });
          }
          capture.trades = trades;
          capture.failed_trades_count = 0;
          turn.failedTradesCount = 0;
          persist();

          let summary = formatTradesToolSummary(trades);
          if (trades.trades.length > 0) {
            status("Tracking suggested trades…");
            try {
              const tracked = await this.autoTrackSuggestedTrades(trades);
              if (tracked && tracked.skipped == null) {
                const parts: string[] = [];
                if (tracked.tracked > 0) parts.push(`opened ${tracked.tracked} paper position${tracked.tracked === 1 ? "" : "s"}`);
                if (tracked.already > 0) parts.push(`${tracked.already} already tracked`);
                if (tracked.failed > 0) parts.push(`${tracked.failed} could not mark`);
                if (parts.length) summary = `${summary}\nPaper portfolio: ${parts.join("; ")}.`;
              }
            } catch (error) {
              console.error("auto-track suggested trades failed", error);
            }
            try {
              const botTracked = await this.autoTrackBotSuggestedTrades(trades);
              if (botTracked && botTracked.skipped == null) {
                const parts: string[] = [];
                if (botTracked.tracked > 0) parts.push(`tracked ${botTracked.tracked}`);
                if (botTracked.already > 0) parts.push(`${botTracked.already} already tracked`);
                if (botTracked.failed > 0) parts.push(`${botTracked.failed} could not mark`);
                if (parts.length) summary = `${summary}\nBot trade book: ${parts.join("; ")}.`;
              }
            } catch (error) {
              console.error("auto-track bot suggested trades failed", error);
            }
          }

          return this.output(true, summary, { error: null, trades });
        }),
      }),
      get_paper_portfolio: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.get_paper_portfolio,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_paper_portfolio,
        execute: async (args) => runTool("get_paper_portfolio", TOOL_LABELS.get_paper_portfolio, args, async () => {
          status("Loading paper portfolio…");
          const statusFilter = args.status ?? "open";
          const conviction = args.conviction ?? null;
          const view = await this.loadPaperPortfolio(statusFilter, conviction);
          if (!view) {
            return this.output(false, "Sign in to view your paper portfolio (tracked suggested trades + PnL).", {
              error: "no_owner",
            });
          }
          return this.output(true, formatPaperPortfolioSummary(view), { error: null });
        }),
      }),
      get_schwab_portfolio: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.get_schwab_portfolio,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_portfolio,
        execute: async (args) => runTool("get_schwab_portfolio", TOOL_LABELS.get_schwab_portfolio, args, async () => {
          status("Loading Schwab portfolio…");
          const result = await this.loadSchwabPortfolio();
          if (!result) {
            return this.output(false, "Sign in and connect Schwab to view your brokerage book.", {
              error: "unavailable",
            });
          }
          if (!result.ok) {
            if (result.reason === "not_connected") {
              return this.output(false, "Schwab is not connected on this account. Connect it from Account settings.", {
                error: "not_connected",
              });
            }
            if (result.reason === "no_owner") {
              return this.output(false, "Sign in to view your Schwab portfolio.", {
                error: "no_owner",
              });
            }
            return this.output(false, result.message || "Could not load the Schwab portfolio.", {
              error: result.reason,
            });
          }
          const session = this.readBotSession();
          const accountId = parseBotSessionAccountFilter(session?.portfolio_account_id)
            || args.account
            || null;
          const view = filterSchwabPortfolioView(result.view, accountId);
          if (accountId && view.accounts.length === 0) {
            return this.output(false, "That Schwab account is not on the linked book.", {
              error: "account_not_found",
            });
          }
          return this.output(true, formatSchwabPortfolioSummary(view), { error: null });
        }),
      }),
      get_schwab_quotes: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.get_schwab_quotes,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_quotes,
        execute: async (args) => runTool("get_schwab_quotes", TOOL_LABELS.get_schwab_quotes, args, async () => {
          status("Loading Schwab quotes…");
          const symbols = sanitizeQuoteSymbols(args.symbols);
          if (symbols.length === 0) {
            return this.output(false, "Pass 1–20 ticker symbols (e.g. AAPL, $SPX). Symbols only — never a user id.", {
              error: "no_symbols",
            });
          }
          const result = await this.loadSchwabQuotes(symbols);
          if (!result) {
            return this.output(false, "Sign in and connect Schwab to pull live quotes from your account.", {
              error: "unavailable",
            });
          }
          if (!result.ok) {
            if (result.reason === "not_connected") {
              return this.output(false, "Schwab is not connected on this account. Connect it from Account settings.", {
                error: "not_connected",
              });
            }
            if (result.reason === "no_owner") {
              return this.output(false, "Sign in to pull live Schwab quotes from your connected account.", {
                error: "no_owner",
              });
            }
            if (result.reason === "no_symbols") {
              return this.output(false, result.message || "No valid symbols to quote.", {
                error: "no_symbols",
              });
            }
            return this.output(false, result.message || "Could not load Schwab quotes.", {
              error: result.reason,
            });
          }
          return this.output(true, formatSchwabQuotesSummary(result.quotes), { error: null });
        }),
      }),
      get_bot_trades: tool({
        description: COPILOT_TOOL_DESCRIPTIONS.get_bot_trades,
        inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_bot_trades,
        execute: async (args) => runTool("get_bot_trades", TOOL_LABELS.get_bot_trades, args, async () => {
          status("Loading bot trade performance…");
          const handle = String(args.handle ?? "").trim();
          const statusFilter = args.status ?? "open";
          const conviction = args.conviction ?? null;
          const book = await this.loadBotTrades(handle, statusFilter, conviction);
          if (!book) {
            return this.output(false, "Unknown or disabled bot handle — try yololobster, nowlobster, or macrolobster.", {
              error: "not_found",
            });
          }
          return this.output(true, formatBotTradesSummary(book), { error: null });
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
      failedTradesCount: typeof capture.failed_trades_count === "number" ? capture.failed_trades_count : 0,
      failedDeskCount: typeof capture.failed_desk_count === "number" ? capture.failed_desk_count : 0,
      stepsAfterQuery: typeof capture.steps_after_query === "number" ? capture.steps_after_query : 0,
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
    // Timeline bots inherit "high" from COPILOT_REASONING_EFFORT and then burn
    // the output budget on planning-only reasoning with no tool calls (prod
    // nowlobster force triggers 2026-08-22). Default bots to medium unless the
    // profile sets an explicit effort; interactive chat keeps the env default.
    const reasoningEffort = bot
      ? (bot.reasoning_effort || "medium")
      : this.env.COPILOT_REASONING_EFFORT;
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
    const userQuestion = latestUserText(this.messages);
    const latestQuestion = userQuestion.toLowerCase();
    const reply = bot ? null : parseReplyPrefFromBody(options.body);
    const deskSpecialists = selectDeskSpecialists(
      userQuestion,
      bot ? `${bot.persona}\n${bot.system_prompt_extra}` : (reply?.note ?? undefined),
    );
    const requestedFrame = this.frameMetadata().find((frame) => latestQuestion.includes(frame.name.toLowerCase()));
    let wroteAnswerStatus = false;
    const activeModel = bot?.model || this.env.COPILOT_MODEL;

    const stream = createUIMessageStream<CopilotMessage>({
      originalMessages,
      onError: (error) => error instanceof Error ? error.message : String(error),
      execute: ({ writer }) => {
        const status = (value: string) => writer.write({ type: "data-status", data: { status: value }, transient: true });
        status("Reasoning over the data…");
        const tools = this.createTools(tables, capture, status, turn, deskSpecialists);
        const result = streamText({
          model,
          system: systemPrompt(schemaToPrompt(tables), { bot, deskSpecialists, reply }),
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
              // Bot thesis posts and interactive chat both publish the routed
              // specialist personas via publish_desk. Structured trades stay
              // interactive-only so a rates post is not forced into a flyer.
              requireDesk: true,
              deskPublished: Boolean(capture.desk),
              stepsAfterQuery: turn.stepsAfterQuery,
              failedDeskCount: turn.failedDeskCount,
              requireTrades: !bot,
              tradesPublished: capture.trades != null,
              failedTradesCount: turn.failedTradesCount,
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
            if (turn.successfulQuery) {
              turn.stepsAfterQuery += 1;
              capture.steps_after_query = turn.stepsAfterQuery;
            }
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
          // Default AI SDK onError masks the real provider/tool failure as
          // "An error occurred." — that is what bot_runs have stored since the
          // schedule outage began. Surface the message so schedule last_error
          // and headless runs are diagnosable.
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({
              copilotStreamError: true,
              botHandle: bot?.handle ?? null,
              model: activeModel,
              error: message,
            }));
            return message;
          },
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
    // Heal DeepSeek DSML that landed in text instead of structured tool parts
    // so live /chat reloads do not show raw markup (and desk/trades/chart survive).
    let deskFromDsml: DeskBrief | null = null;
    let tradesFromDsml: SuggestedTrades | null = null;
    let chartFromDsml: ChartSpec | null = null;
    const parts = message.parts.map((part) => {
      if (part.type === "text" && typeof part.text === "string" && looksLikeDsmlToolMarkup(part.text)) {
        const calls = parseDsmlToolCalls(part.text);
        for (const call of calls) {
          if (call.name === "publish_desk" && !deskFromDsml) {
            deskFromDsml = normalizeDeskBrief(call.args as DeskBriefInput);
          }
          if (call.name === "suggest_trades" && !tradesFromDsml) {
            tradesFromDsml = normalizeSuggestedTrades(call.args as { trades?: unknown; skip_reason?: unknown });
          }
          if (call.name === "render_chart" && !chartFromDsml) {
            const args = call.args;
            const kind = args.kind;
            if (
              (kind === "line" || kind === "area" || kind === "scatter" || kind === "bar")
              && typeof args.x === "string" && args.x.trim()
              && typeof args.y === "string" && args.y.trim()
            ) {
              chartFromDsml = {
                kind,
                x: args.x.trim(),
                y: args.y.trim(),
                ...(typeof args.title === "string" && args.title.trim() ? { title: args.title.trim() } : {}),
                ...(typeof args.series === "string" && args.series.trim() ? { series: args.series.trim() } : {}),
              };
            }
          }
        }
        const stripped = stripLeakedToolMarkup(part.text);
        const nextText = (deskFromDsml?.overview || stripped || "").trim();
        return { ...part, text: nextText };
      }
      if (part.type === "text" && typeof part.text === "string") {
        const stripped = stripLeakedToolMarkup(part.text);
        return stripped === part.text ? part : { ...part, text: stripped };
      }
      if (!("output" in part) || part.state !== "output-available" || !part.output || typeof part.output !== "object") {
        return part;
      }
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
    });

    const prevMeta = (message.metadata && typeof message.metadata === "object")
      ? message.metadata as Record<string, unknown>
      : {};
    const nextMeta = {
      ...prevMeta,
      ...(deskFromDsml && !prevMeta.desk ? { desk: deskFromDsml } : {}),
      ...(tradesFromDsml && !prevMeta.trades ? { trades: tradesFromDsml } : {}),
      ...(chartFromDsml && !prevMeta.chart ? { chart: chartFromDsml } : {}),
    };

    return {
      ...message,
      parts,
      ...(Object.keys(nextMeta).length ? { metadata: nextMeta } : {}),
    };
  }
}
