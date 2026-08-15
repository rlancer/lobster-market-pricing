/**
 * Durable Copilot tool-call events for debugging.
 *
 * CopilotAgent records every tool outcome (ok / error / args / sql) into D1
 * `copilot_tool_events`. Lake `options.chat_history` deliberately strips tools;
 * this table is the only durable index of failed tool calls. The read path is
 * public (`GET /api/tool_calls`) — payloads are capped tool args/errors/SQL,
 * not transcripts or abuse metadata. Pass `share_id` to resolve a share's
 * originating chat without needing ADMIN_TOKEN.
 */

export const TOOL_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TOOL_EVENT_ARGS_MAX = 4_000;
export const TOOL_EVENT_SUMMARY_MAX = 2_000;
export const TOOL_EVENT_ERROR_MAX = 2_000;
export const TOOL_EVENT_SQL_MAX = 8_000;
export const TOOL_EVENT_ADMIN_LIMIT_MAX = 500;
export const TOOL_EVENT_AUX_MAX = 128;

const KNOWN_TOOLS = new Set([
  "run_query",
  "check_schema",
  "list_frames",
  "filter_frame",
  "refresh_frame",
  "render_chart",
  "get_news",
  "web_search",
  "eco_calendar",
  "research_ticker",
]);

export interface ToolEventInput {
  event_id: string;
  chat_id: string;
  turn_id: string;
  tool_name: string;
  ok: boolean;
  args: unknown;
  error?: string | null;
  summary?: string | null;
  sql?: string | null;
  duration_ms?: number | null;
  model?: string | null;
  created_at?: number;
}

export interface ToolEventRow {
  event_id: string;
  chat_id: string;
  turn_id: string;
  tool_name: string;
  ok: boolean;
  args: unknown;
  error: string | null;
  summary: string | null;
  sql: string | null;
  duration_ms: number | null;
  model: string | null;
  created_at: number;
  created_at_iso: string;
}

export interface ToolEventListQuery {
  chat_id?: string | null;
  share_id?: string | null;
  tool?: string | null;
  /** null = no ok filter (all outcomes). */
  ok?: boolean | null;
  limit?: number;
  before?: string | null;
}

export interface ToolEventListResult {
  ok: true;
  limit: number;
  before: string | null;
  chat_id: string | null;
  share_id: string | null;
  tool: string | null;
  ok_filter: boolean | null;
  items: ToolEventRow[];
  as_of: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function trimOrNull(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Cap JSON args for D1 — never persist unbounded model payloads. */
export function serializeToolArgs(args: unknown): string {
  try {
    const raw = JSON.stringify(args ?? null);
    if (raw.length <= TOOL_EVENT_ARGS_MAX) return raw;
    return JSON.stringify({ _truncated: true, preview: raw.slice(0, TOOL_EVENT_ARGS_MAX - 40) });
  } catch {
    return JSON.stringify({ _error: "args_not_serializable" });
  }
}

export function parseToolArgsJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _error: "args_parse_failed", raw: raw.slice(0, 200) };
  }
}

export function normalizeToolEvent(input: ToolEventInput): {
  event_id: string;
  chat_id: string;
  turn_id: string;
  tool_name: string;
  ok: number;
  args_json: string;
  error: string | null;
  summary: string | null;
  sql_text: string | null;
  duration_ms: number | null;
  model: string | null;
  created_at: number;
} {
  const eventId = trimOrNull(input.event_id, TOOL_EVENT_AUX_MAX);
  const chatId = trimOrNull(input.chat_id, TOOL_EVENT_AUX_MAX);
  const turnId = trimOrNull(input.turn_id, TOOL_EVENT_AUX_MAX);
  const toolName = trimOrNull(input.tool_name, TOOL_EVENT_AUX_MAX);
  if (!eventId || !chatId || !turnId || !toolName) {
    throw new Error("event_id, chat_id, turn_id, and tool_name are required");
  }
  const duration =
    typeof input.duration_ms === "number" && Number.isFinite(input.duration_ms)
      ? Math.max(0, Math.round(input.duration_ms))
      : null;
  const createdAt =
    typeof input.created_at === "number" && Number.isFinite(input.created_at)
      ? Math.round(input.created_at)
      : Date.now();
  return {
    event_id: eventId,
    chat_id: chatId,
    turn_id: turnId,
    tool_name: toolName,
    ok: input.ok ? 1 : 0,
    args_json: serializeToolArgs(input.args),
    error: trimOrNull(input.error, TOOL_EVENT_ERROR_MAX),
    summary: trimOrNull(input.summary, TOOL_EVENT_SUMMARY_MAX),
    sql_text: trimOrNull(input.sql, TOOL_EVENT_SQL_MAX),
    duration_ms: duration,
    model: trimOrNull(input.model, TOOL_EVENT_AUX_MAX),
    created_at: createdAt,
  };
}

/**
 * Parse tool-call list filters. Omitting `ok` defaults to failures (`false`) —
 * that is the debug use case. Pass `ok=all` for every outcome, or
 * `ok=true` / `ok=false` explicitly. `share_id` resolves to the originating
 * chat_id via shared_chats (so a share URL is enough to debug).
 */
export function parseToolEventListQuery(params: URLSearchParams): ToolEventListQuery & { error?: string } {
  const limitRaw = params.get("limit");
  let limit = 100;
  if (limitRaw != null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n < 1) return { error: "limit must be a positive integer" };
    limit = clamp(Math.round(n), 1, TOOL_EVENT_ADMIN_LIMIT_MAX);
  }

  const chatId = trimOrNull(params.get("chat_id"), TOOL_EVENT_AUX_MAX);
  const shareId = trimOrNull(params.get("share_id"), TOOL_EVENT_AUX_MAX);
  const toolRaw = trimOrNull(params.get("tool"), TOOL_EVENT_AUX_MAX);
  if (toolRaw && !KNOWN_TOOLS.has(toolRaw)) {
    return { error: `unknown tool '${toolRaw}'` };
  }

  const okRaw = params.get("ok");
  let ok: boolean | null = false; // default: failures only
  if (okRaw != null && okRaw !== "") {
    if (okRaw === "all" || okRaw === "*") ok = null;
    else if (okRaw === "true" || okRaw === "1") ok = true;
    else if (okRaw === "false" || okRaw === "0") ok = false;
    else return { error: "ok must be true, false, or all" };
  }

  const beforeRaw = params.get("before");
  let before: string | null = null;
  if (beforeRaw) {
    if (!Number.isFinite(Date.parse(beforeRaw))) return { error: "before must be an ISO timestamp" };
    before = beforeRaw;
  }

  return { chat_id: chatId, share_id: shareId, tool: toolRaw, ok, limit, before };
}

/** Look up the originating chat_id for a public share. */
export async function chatIdForShare(db: D1Database, shareId: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT chat_id FROM shared_chats WHERE share_id = ?1 LIMIT 1",
  ).bind(shareId).first<{ chat_id: string }>();
  return row?.chat_id ?? null;
}

function rowToEvent(row: {
  event_id: string;
  chat_id: string;
  turn_id: string;
  tool_name: string;
  ok: number;
  args_json: string;
  error: string | null;
  summary: string | null;
  sql_text: string | null;
  duration_ms: number | null;
  model: string | null;
  created_at: number;
}): ToolEventRow {
  return {
    event_id: row.event_id,
    chat_id: row.chat_id,
    turn_id: row.turn_id,
    tool_name: row.tool_name,
    ok: row.ok === 1,
    args: parseToolArgsJson(row.args_json),
    error: row.error,
    summary: row.summary,
    sql: row.sql_text,
    duration_ms: row.duration_ms,
    model: row.model,
    created_at: row.created_at,
    created_at_iso: new Date(row.created_at).toISOString(),
  };
}

/** Best-effort insert — never throws to the caller (debug capture must not break chat). */
export async function insertToolEvent(db: D1Database, input: ToolEventInput): Promise<void> {
  try {
    const row = normalizeToolEvent(input);
    await db.prepare(
      `INSERT OR REPLACE INTO copilot_tool_events
        (event_id, chat_id, turn_id, tool_name, ok, args_json, error, summary, sql_text, duration_ms, model, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      row.event_id,
      row.chat_id,
      row.turn_id,
      row.tool_name,
      row.ok,
      row.args_json,
      row.error,
      row.summary,
      row.sql_text,
      row.duration_ms,
      row.model,
      row.created_at,
    ).run();
  } catch (e) {
    console.error("copilot tool event insert failed", e);
  }
}

export async function purgeExpiredToolEvents(db: D1Database, now = Date.now()): Promise<void> {
  try {
    const cutoff = now - TOOL_EVENT_RETENTION_MS;
    await db.prepare("DELETE FROM copilot_tool_events WHERE created_at < ?1").bind(cutoff).run();
  } catch (e) {
    console.error("copilot tool event purge failed", e);
  }
}

export async function listToolEvents(db: D1Database, query: ToolEventListQuery): Promise<ToolEventListResult> {
  const limit = clamp(query.limit ?? 100, 1, TOOL_EVENT_ADMIN_LIMIT_MAX);
  const chatId = trimOrNull(query.chat_id, TOOL_EVENT_AUX_MAX);
  const shareId = trimOrNull(query.share_id, TOOL_EVENT_AUX_MAX);
  const tool = trimOrNull(query.tool, TOOL_EVENT_AUX_MAX);
  const okFilter = typeof query.ok === "boolean" ? query.ok : null;
  const beforeIso = query.before && Number.isFinite(Date.parse(query.before)) ? query.before : null;
  const beforeMs = beforeIso ? Date.parse(beforeIso) : null;

  const where: string[] = [];
  const bindings: (string | number)[] = [];
  if (chatId) {
    where.push(`chat_id = ?${bindings.length + 1}`);
    bindings.push(chatId);
  }
  if (tool) {
    where.push(`tool_name = ?${bindings.length + 1}`);
    bindings.push(tool);
  }
  if (okFilter !== null) {
    where.push(`ok = ?${bindings.length + 1}`);
    bindings.push(okFilter ? 1 : 0);
  }
  if (beforeMs != null) {
    where.push(`created_at < ?${bindings.length + 1}`);
    bindings.push(beforeMs);
  }
  bindings.push(limit);

  const sql =
    `SELECT event_id, chat_id, turn_id, tool_name, ok, args_json, error, summary, sql_text, duration_ms, model, created_at ` +
    `FROM copilot_tool_events ` +
    (where.length ? `WHERE ${where.join(" AND ")} ` : "") +
    `ORDER BY created_at DESC, event_id DESC LIMIT ?${bindings.length}`;

  const rows = await db.prepare(sql).bind(...bindings).all<{
    event_id: string;
    chat_id: string;
    turn_id: string;
    tool_name: string;
    ok: number;
    args_json: string;
    error: string | null;
    summary: string | null;
    sql_text: string | null;
    duration_ms: number | null;
    model: string | null;
    created_at: number;
  }>();

  return {
    ok: true,
    limit,
    before: beforeIso,
    chat_id: chatId,
    share_id: shareId,
    tool,
    ok_filter: okFilter,
    items: (rows.results ?? []).map(rowToEvent),
    as_of: new Date().toISOString(),
  };
}
