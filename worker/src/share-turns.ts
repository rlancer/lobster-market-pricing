/**
 * Flatten AI SDK UIMessage parts into share/timeline turns.
 */
import type { UIMessage } from "ai";
import { chartFitsResult, inferChartSpec, wantsChart, type ChartSpec } from "./chart-spec";
import { normalizeDeskBrief, type DeskBrief, type DeskBriefInput } from "./chat-desk";
import { normalizeSuggestedTrades, type SuggestedTrades } from "./chat-trades";
import { looksLikeDsmlToolMarkup, parseDsmlToolCalls } from "./dsml";
import { stripLeakedToolMarkup } from "./tool-markup";

/** Cap on SQL statements kept per assistant turn (share / Floor / live chat). */
export const SHARE_MAX_QUERIES = 20;

const SQL_QUERY_TOOLS = new Set(["run_query", "check_schema", "filter_frame", "refresh_frame"]);

/** First-seen unique SQLs, trimmed, capped. Later duplicates are dropped. */
export function mergeSqlQueries(
  ...lists: Array<readonly string[] | null | undefined>
): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const sql = typeof raw === "string" ? raw.trim() : "";
      if (!sql || out.includes(sql)) continue;
      out.push(sql);
      if (out.length >= SHARE_MAX_QUERIES) return out;
    }
  }
  return out;
}

function sqlFromRecord(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sql = (value as Record<string, unknown>).sql;
  return typeof sql === "string" && sql.trim() ? sql.trim() : undefined;
}

function sqlsFromUnknown(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const queries = mergeSqlQueries(value.filter((item): item is string => typeof item === "string"));
  return queries.length ? queries : undefined;
}

/** Compact tool row for share/timeline “Tools used” disclosure. */
export type ShareToolRow = {
  name: string;
  args?: string;
  ok?: boolean;
  summary?: string;
};

/** Session frame metadata — same shape as live ChatContextStrip Sources. */
export type ShareFrame = {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
};

export type ShareTurn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sql?: string;
  /** Every lake query this turn ran (run_query / check_schema / frame slice). */
  queries?: string[];
  chart?: ChartSpec;
  desk?: DeskBrief;
  trades?: SuggestedTrades;
  tools?: ShareToolRow[];
  frames?: ShareFrame[];
  /** Per-turn asker when a timeline follow-up forks another user's share. */
  author?: { handle: string; name: string; is_bot?: boolean; avatar_url?: string | null };
  ts?: number;
};

export type ShareCapture = {
  sql?: string | null;
  queries?: string[] | null;
  result?: { columns?: string[]; rows?: Record<string, unknown>[]; error?: string } | null;
  chart?: ChartSpec | null;
  desk?: DeskBrief | null;
  trades?: SuggestedTrades | null;
};

/** True when an assistant turn has anything worth showing (or merging). */
export function assistantShareTurnHasSubstance(turn: Pick<ShareTurn, "content" | "reasoning" | "sql" | "queries" | "chart" | "desk" | "trades" | "tools" | "frames">): boolean {
  return Boolean(
    (typeof turn.content === "string" && turn.content.trim())
    || (typeof turn.reasoning === "string" && turn.reasoning.trim())
    || (typeof turn.sql === "string" && turn.sql.trim())
    || (turn.queries && turn.queries.length > 0)
    || turn.chart
    || turn.desk
    || turn.trades
    || (turn.tools && turn.tools.length > 0)
    || (turn.frames && turn.frames.length > 0),
  );
}

/**
 * Merge consecutive assistant turns from chatRecovery retries into one.
 * Each stalled desk attempt used to land as another empty bubble on /share
 * and in live chat (user → assistant → assistant → assistant).
 */
export function mergeAssistantShareTurns(earlier: ShareTurn, later: ShareTurn): ShareTurn {
  const desk = later.desk ?? earlier.desk;
  const content = (
    desk?.overview
    || (later.content?.trim() ? later.content : "")
    || earlier.content
    || ""
  ).trim();
  const merged: ShareTurn = {
    role: "assistant",
    content: content || ((later.reasoning || earlier.reasoning) ? "(see reasoning)" : ""),
  };
  const reasoning = (later.reasoning?.trim() || earlier.reasoning || "").trim();
  if (reasoning) merged.reasoning = reasoning;
  const sql = later.sql?.trim() || earlier.sql;
  if (sql) merged.sql = sql;
  const queries = mergeSqlQueries(
    earlier.queries,
    earlier.sql ? [earlier.sql] : undefined,
    later.queries,
    later.sql ? [later.sql] : undefined,
  );
  if (queries.length) merged.queries = queries;
  if (later.chart || earlier.chart) merged.chart = later.chart ?? earlier.chart;
  if (desk) merged.desk = desk;
  if (later.trades || earlier.trades) merged.trades = later.trades ?? earlier.trades;
  // Prefer the later catalog (session frames accumulate); fall back to earlier.
  if (later.frames?.length) merged.frames = later.frames;
  else if (earlier.frames?.length) merged.frames = earlier.frames;
  if (later.tools?.length || earlier.tools?.length) {
    merged.tools = [...(earlier.tools ?? []), ...(later.tools ?? [])].slice(0, 20);
  }
  if (later.ts != null || earlier.ts != null) merged.ts = later.ts ?? earlier.ts;
  return merged;
}

/**
 * Recover desk / trades / chart when DeepSeek left DSML tool markup in text
 * instead of structured tool parts. Strips the markup and prefers the desk
 * overview as visible content.
 */
export function healShareTurnFromDsml(turn: ShareTurn): ShareTurn {
  if (turn.role !== "assistant") return turn;
  const content = typeof turn.content === "string" ? turn.content : "";
  if (!looksLikeDsmlToolMarkup(content)) {
    // Still strip generic XML tool envelopes / orphan tags.
    const stripped = stripLeakedToolMarkup(content);
    return stripped === content ? turn : { ...turn, content: stripped };
  }

  const calls = parseDsmlToolCalls(content);
  let desk = turn.desk ?? null;
  let trades = turn.trades ?? null;
  let chart = turn.chart ?? null;
  for (const call of calls) {
    if (call.name === "publish_desk" && !desk) {
      const next = normalizeDeskBrief(call.args as DeskBriefInput);
      if (next) desk = next;
    }
    if (call.name === "suggest_trades" && !trades) {
      const next = normalizeSuggestedTrades(call.args as { trades?: unknown; skip_reason?: unknown });
      if (next) trades = next;
    }
    if (call.name === "render_chart" && !chart) {
      const next = asChartSpec(call.args);
      if (next) chart = next;
    }
  }

  const stripped = stripLeakedToolMarkup(content);
  const nextContent = (desk?.overview || stripped || "").trim()
    || (turn.reasoning ? "(see reasoning)" : "");

  const out: ShareTurn = { ...turn, content: nextContent };
  if (desk) out.desk = desk;
  if (trades) out.trades = trades;
  if (chart) out.chart = chart;
  return out;
}

function shareTurnFromRecord(rec: Record<string, unknown>): ShareTurn {
  const queries = sqlsFromUnknown(rec.queries);
  return {
    role: "assistant",
    content: typeof rec.content === "string" ? rec.content : "",
    ...(typeof rec.reasoning === "string" ? { reasoning: rec.reasoning } : {}),
    ...(typeof rec.sql === "string" ? { sql: rec.sql } : {}),
    ...(queries ? { queries } : {}),
    ...(rec.chart && typeof rec.chart === "object" ? { chart: rec.chart as ChartSpec } : {}),
    ...(rec.desk && typeof rec.desk === "object" ? { desk: rec.desk as DeskBrief } : {}),
    ...(rec.trades && typeof rec.trades === "object" ? { trades: rec.trades as SuggestedTrades } : {}),
    ...(Array.isArray(rec.tools) ? { tools: rec.tools as ShareToolRow[] } : {}),
    ...(Array.isArray(rec.frames) ? { frames: rec.frames as ShareFrame[] } : {}),
    ...(typeof rec.ts === "number" ? { ts: rec.ts } : {}),
  };
}

function recordFromShareTurn(turn: ShareTurn, result?: unknown): Record<string, unknown> {
  const next: Record<string, unknown> = { role: "assistant", content: turn.content };
  if (turn.reasoning) next.reasoning = turn.reasoning;
  if (turn.sql) next.sql = turn.sql;
  if (turn.queries?.length) next.queries = turn.queries;
  if (turn.chart) next.chart = turn.chart;
  if (turn.desk) next.desk = turn.desk;
  if (turn.trades) next.trades = turn.trades;
  if (turn.tools?.length) next.tools = turn.tools;
  if (turn.frames?.length) next.frames = turn.frames;
  if (turn.ts != null) next.ts = turn.ts;
  if (result != null) next.result = result;
  return next;
}

/** Collapse recovery debris: consecutive assistants → one turn; drop empty shells. */
export function coalesceAssistantShareTurns(turns: ShareTurn[]): ShareTurn[] {
  const out: ShareTurn[] = [];
  for (const raw of turns) {
    const turn = raw.role === "assistant" ? healShareTurnFromDsml(raw) : raw;
    if (turn.role !== "assistant") {
      out.push(turn);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.role === "assistant") {
      out[out.length - 1] = mergeAssistantShareTurns(prev, turn);
      continue;
    }
    if (!assistantShareTurnHasSubstance(turn)) continue;
    out.push(turn);
  }
  return out;
}

/**
 * Same coalesce for stored share/timeline JSON rows ({role, content, …}).
 * Used on share write + public read so existing multi-bubble shares heal.
 * Also recovers DeepSeek DSML tool markup left in assistant content.
 */
export function coalesceAssistantMessageRecords(messages: unknown): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rec = { ...(raw as Record<string, unknown>) };
    const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    rec.role = role;
    if (role !== "assistant") {
      out.push(rec);
      continue;
    }
    const asTurn = healShareTurnFromDsml(shareTurnFromRecord(rec));
    // Write healed desk/content back onto the record before merge / push.
    Object.assign(rec, recordFromShareTurn(asTurn, rec.result));
    const prev = out[out.length - 1];
    if (prev?.role === "assistant") {
      const earlier = healShareTurnFromDsml(shareTurnFromRecord(prev));
      const merged = mergeAssistantShareTurns(earlier, asTurn);
      const next = recordFromShareTurn(
        merged,
        rec.result != null ? rec.result : prev.result,
      );
      out[out.length - 1] = next;
      continue;
    }
    if (!assistantShareTurnHasSubstance(asTurn) && rec.result == null) continue;
    out.push(rec);
  }
  return out;
}

type ToolPayload = {
  sql?: unknown;
  result?: { columns?: unknown; rows?: unknown } | null;
  chart?: unknown;
  desk?: unknown;
  trades?: unknown;
  frames?: unknown;
  ok?: unknown;
  summary?: unknown;
  error?: unknown;
};

function asShareFrames(value: unknown): ShareFrame[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ShareFrame[] = [];
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim()) continue;
    if (typeof rec.sql !== "string") continue;
    if (typeof rec.row_count !== "number" || !Number.isFinite(rec.row_count)) continue;
    if (typeof rec.fetched_at !== "number" || !Number.isFinite(rec.fetched_at)) continue;
    const columns = Array.isArray(rec.columns)
      ? rec.columns.filter((c): c is string => typeof c === "string").slice(0, 40)
      : [];
    out.push({
      name: rec.name.trim().slice(0, 80),
      columns,
      row_count: rec.row_count,
      sql: rec.sql.slice(0, 20_000),
      fetched_at: rec.fetched_at,
    });
  }
  return out.length ? out : null;
}

/** Compact human-readable tool args for share/timeline (mirrors live chat). */
function formatShareToolArgs(name: string, input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return String(input).slice(0, 120);
  const o = input as Record<string, unknown>;
  const squeeze = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();
  switch (name) {
    case "run_query":
    case "check_schema":
      return squeeze(o.sql).slice(0, 140);
    case "filter_frame": {
      const bits: string[] = [String(o.frame ?? "")];
      if (o.where) bits.push(`where ${squeeze(o.where)}`);
      if (o.sort) bits.push(`sort ${squeeze(o.sort)}`);
      if (o.limit != null) bits.push(`limit ${String(o.limit)}`);
      return bits.filter(Boolean).join(" · ").slice(0, 140);
    }
    case "refresh_frame":
      return String(o.frame ?? "").slice(0, 80);
    case "render_chart":
      return `${String(o.kind ?? "line")} · ${String(o.x ?? "?")} × ${String(o.y ?? "?")}${o.series ? ` by ${String(o.series)}` : ""}`;
    case "get_news":
    case "research_ticker":
      return String(o.symbol ?? "").toUpperCase();
    case "lookup_symbols":
      return Array.isArray(o.symbols)
        ? o.symbols.map((s) => String(s ?? "").toUpperCase()).filter(Boolean).slice(0, 8).join(", ")
        : "";
    case "web_search":
      return squeeze(o.query).slice(0, 120);
    case "eco_calendar":
      return o.days != null ? `next ${o.days} days` : "";
    case "list_frames":
      return "";
    case "publish_desk":
      return "desk";
    case "suggest_trades":
      return Array.isArray(o.trades) ? `${o.trades.length} trade${o.trades.length === 1 ? "" : "s"}` : "";
    default:
      return JSON.stringify(input).slice(0, 140);
  }
}

function toolPartState(part: { state?: unknown }): string {
  return typeof part.state === "string" ? part.state : "";
}

function asChartSpec(value: unknown): ChartSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== "line" && kind !== "area" && kind !== "scatter" && kind !== "bar") return null;
  if (typeof rec.x !== "string" || !rec.x.trim()) return null;
  if (typeof rec.y !== "string" || !rec.y.trim()) return null;
  const chart: ChartSpec = { kind, x: rec.x.trim(), y: rec.y.trim() };
  if (typeof rec.title === "string" && rec.title.trim()) chart.title = rec.title.trim();
  if (typeof rec.series === "string" && rec.series.trim()) chart.series = rec.series.trim();
  if (typeof rec.xLabel === "string" && rec.xLabel.trim()) chart.xLabel = rec.xLabel.trim();
  if (typeof rec.yLabel === "string" && rec.yLabel.trim()) chart.yLabel = rec.yLabel.trim();
  return chart;
}

function asQueryResult(value: unknown): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as { columns?: unknown; rows?: unknown; error?: unknown };
  if (typeof rec.error === "string" && rec.error.trim()) return null;
  if (!Array.isArray(rec.columns) || !rec.columns.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(rec.rows)) return null;
  return {
    columns: rec.columns as string[],
    rows: rec.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row)),
  };
}

const PLACEHOLDER_SHARE_CONTENT = /^(?:\(see reasoning\)|see reasoning|…|\.{3}|n\/a|tbd|\(see tools\))?$/i;
const REASONING_SCRATCH =
  /^(?:plan of tool|batch\s*\d|tool calls?|actually[, ]|hmm[, ]|alternatively[, ]|wait[, ]|let me (?:write|draft|compose|summarize|review|first|start|call|run|do|just|also|recompute|see|check|pull|get|lookup)|now[, ]|the private account|given the task|should i call)/i;
const REASONING_UNFINISHED =
  /\b(?:let me (?:query|check|look|pull|run|render|use|get|find|start|write|draft)|i(?:'ll| will) (?:query|check|pull|run|write)|i need to)\b/i;

export function isInterimToolNarration(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_SHARE_CONTENT.test(trimmed)) return true;
  if (REASONING_UNFINISHED.test(trimmed)) return true;
  if (/(?:let me|i'll|i will)\s+[a-z0-9_ -]+[.!?]?$/i.test(trimmed)) return true;
  return false;
}

/**
 * DeepSeek bot turns often leave the visible text channel empty ("(see reasoning)")
 * or with only an interim transition ("Let me pull..."), while the real analysis
 * lives in the reasoning stream. When the content is a placeholder or unfinished
 * narration, lift the substantive reasoning block into content so the share UI
 * sees a finished answer.
 */
export function promoteReasoningTakeaway(turn: ShareTurn): ShareTurn {
  const content = (turn.content ?? "").trim();
  const reasoning = (turn.reasoning ?? "").trim();
  if (!reasoning) return turn;
  if (content && !isInterimToolNarration(content) && content.length >= 40) return turn;

  const paras = reasoning
    .split(/\n\s*\n/)
    .map((p) => stripLeakedToolMarkup(p))
    .filter(Boolean);

  const substantive: string[] = [];
  for (let i = paras.length - 1; i >= 0; i--) {
    const para = paras[i]!;
    if (para.length < 40) {
      if (substantive.length > 0) break;
      continue;
    }
    if (REASONING_SCRATCH.test(para) || REASONING_UNFINISHED.test(para)) {
      if (substantive.length > 0) break;
      continue;
    }
    if (substantive.length === 0 && !/[.!?…:\-)\]"'%a-z0-9]\s*$/i.test(para)) {
      continue;
    }
    substantive.unshift(para);
    if (substantive.join("\n\n").length >= 4_000) break;
  }

  if (substantive.length > 0) {
    const joined = substantive.join("\n\n").slice(0, 5_000).trim();
    if (joined.length >= 40) {
      return { ...turn, content: joined };
    }
  }

  return turn;
}

/**
 * Stamp the last assistant turn with the DO turn-budget capture.
 * Message parts sometimes omit tool outputs after headless runs / mid-turn
 * recovery; capture_json is the authoritative sql/result/chart/desk/trades from the
 * completed turn (publish_desk / suggest_trades included).
 */
export function applyCaptureToShareTurns(
  turns: ShareTurn[],
  capture: ShareCapture | null | undefined,
  question = "",
): ShareTurn[] {
  if (!capture || !turns.length) return turns;
  const out = turns.map((turn) => ({ ...turn }));
  let assistantIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "assistant") {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 0) return out;
  const turn = out[assistantIdx];
  const captureSql = typeof capture.sql === "string" && capture.sql.trim() ? capture.sql.trim() : null;
  const captureQueries = mergeSqlQueries(turn.queries, capture.queries, captureSql ? [captureSql] : undefined);
  if (captureSql) turn.sql = captureSql;
  if (captureQueries.length) turn.queries = captureQueries;
  let chart = turn.chart ?? asChartSpec(capture.chart);
  const result = asQueryResult(capture.result);
  if (chart && result && !chartFitsResult(chart, result.columns)) chart = null;
  if (!chart && result && wantsChart(question)) {
    chart = inferChartSpec(result.columns, result.rows);
  }
  if (chart) turn.chart = chart;
  if (!turn.desk && capture.desk) {
    const desk = normalizeDeskBrief(capture.desk);
    if (desk) {
      turn.desk = desk;
      // Desk overview is the canonical visible answer; mid-turn "Let me…"
      // narration must not win when capture recovered the desk.
      if (desk.overview) turn.content = desk.overview;
    }
  }
  if (!turn.trades && capture.trades) {
    const trades = normalizeSuggestedTrades(capture.trades);
    if (trades) turn.trades = trades;
  }
  out[assistantIdx] = promoteReasoningTakeaway(turn);
  return out;
}

/** Flatten UIMessage parts into share/timeline turns (text + optional reasoning/sql/chart). */
export function extractShareTurns(messages: UIMessage[]): ShareTurn[] {
  const out: ShareTurn[] = [];
  let lastUserQuestion = "";
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Keep raw assistant text so healShareTurnFromDsml can recover desk/trades/chart
    // from DeepSeek DSML before strip runs inside coalesce.
    const rawContent = message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof (part as { text?: string }).text === "string")
      .map((part) => part.text)
      .join("");
    const content = message.role === "assistant" ? rawContent : stripLeakedToolMarkup(rawContent);
    const reasoning = message.parts
      .filter((part): part is { type: "reasoning"; text: string } => part.type === "reasoning" && typeof (part as { text?: string }).text === "string")
      .map((part) => part.text)
      .join("")
      .trim();

    let sql: string | undefined;
    let queries: string[] = [];
    let chart: ChartSpec | null = null;
    let result: { columns: string[]; rows: Record<string, unknown>[] } | null = null;
    let desk: DeskBrief | null = null;
    let trades: SuggestedTrades | null = null;
    let frames: ShareFrame[] | null = null;
    const tools: ShareToolRow[] = [];
    for (const part of message.parts) {
      const type = typeof (part as { type?: unknown }).type === "string"
        ? String((part as { type: string }).type)
        : "";
      const named = typeof (part as { toolName?: unknown }).toolName === "string"
        ? String((part as { toolName: string }).toolName)
        : "";
      const toolName = type.startsWith("tool-") ? type.slice("tool-".length) : named;
      if (!toolName || type === "text" || type === "reasoning") continue;
      const input = "input" in part ? (part as { input?: unknown }).input : undefined;
      const state = toolPartState(part as { state?: unknown });
      const hasOutput = "output" in part && part.output != null;
      const output = hasOutput && typeof part.output === "object" ? part.output as ToolPayload : undefined;
      const complete = state === "output-available" || state === "output-error" || state === "complete"
        || state === "error" || state === "denied" || Boolean(output);
      if (tools.length < 20) {
        const row: ShareToolRow = { name: toolName };
        const args = formatShareToolArgs(toolName, input);
        if (args) row.args = args;
        if (complete) {
          row.ok = state !== "output-error" && state !== "error" && state !== "denied" && output?.ok !== false;
          const summary = typeof output?.summary === "string"
            ? output.summary
            : typeof output?.error === "string"
              ? output.error
              : "";
          if (summary) row.summary = summary.slice(0, 500);
        }
        tools.push(row);
      }
      if (SQL_QUERY_TOOLS.has(toolName)) {
        const fromInput = sqlFromRecord(input);
        if (fromInput) queries = mergeSqlQueries(queries, [fromInput]);
      }
      // render_chart args are themselves a ChartSpec — keep them even when output was stripped.
      if (toolName === "render_chart") {
        const fromInput = asChartSpec(input);
        if (fromInput) chart = fromInput;
      }
      if (toolName === "publish_desk" && input && typeof input === "object") {
        const fromInput = normalizeDeskBrief(input as DeskBriefInput);
        if (fromInput) desk = fromInput;
      }
      if (toolName === "suggest_trades" && input && typeof input === "object") {
        const fromInput = normalizeSuggestedTrades(input as { trades?: unknown; skip_reason?: unknown });
        if (fromInput) trades = fromInput;
      }
      if (!output) continue;
      if (typeof output.sql === "string" && output.sql.trim()) {
        sql = output.sql.trim();
        if (SQL_QUERY_TOOLS.has(toolName)) queries = mergeSqlQueries(queries, [sql]);
      }
      const nextResult = asQueryResult(output.result);
      if (nextResult) {
        result = nextResult;
        if (chart && !chartFitsResult(chart, result.columns)) chart = null;
      }
      const nextChart = asChartSpec(output.chart) ?? (toolName === "render_chart" ? asChartSpec(input) : null);
      if (nextChart) {
        chart = nextChart;
        if (result && !chartFitsResult(chart, result.columns)) chart = null;
      }
      if (output.desk && typeof output.desk === "object") {
        const fromOutput = normalizeDeskBrief(output.desk as DeskBriefInput);
        if (fromOutput) desk = fromOutput;
      }
      if (output.trades && typeof output.trades === "object") {
        const fromOutput = normalizeSuggestedTrades(output.trades as { trades?: unknown; skip_reason?: unknown });
        if (fromOutput) trades = fromOutput;
      }
      const nextFrames = asShareFrames(output.frames);
      if (nextFrames) frames = nextFrames;
    }

    const meta = message.metadata as {
      createdAt?: number;
      sql?: string;
      queries?: unknown;
      chart?: unknown;
      desk?: unknown;
      trades?: unknown;
      frames?: unknown;
    } | undefined;
    if (!sql && typeof meta?.sql === "string" && meta.sql.trim()) sql = meta.sql.trim();
    queries = mergeSqlQueries(queries, sqlsFromUnknown(meta?.queries), sql ? [sql] : undefined);
    if (!chart) {
      const metaChart = asChartSpec(meta?.chart);
      if (metaChart && (!result || chartFitsResult(metaChart, result.columns))) chart = metaChart;
    }
    if (!desk && meta?.desk && typeof meta.desk === "object") {
      const fromMeta = normalizeDeskBrief(meta.desk as DeskBriefInput);
      if (fromMeta) desk = fromMeta;
    }
    if (!trades && meta?.trades && typeof meta.trades === "object") {
      const fromMeta = normalizeSuggestedTrades(meta.trades as { trades?: unknown; skip_reason?: unknown });
      if (fromMeta) trades = fromMeta;
    }
    if (!frames) {
      const metaFrames = asShareFrames(meta?.frames);
      if (metaFrames) frames = metaFrames;
    }

    // Live chat falls back to inferChartSpec when the model skips render_chart;
    // mirror that for headless bot shares so timeline posts keep a figure.
    if (!chart && result && wantsChart(lastUserQuestion)) {
      chart = inferChartSpec(result.columns, result.rows);
    }

    if (message.role === "user" && content) lastUserQuestion = content;
    if (!content && !reasoning && !tools.length && !frames) continue;
    const turn: ShareTurn = {
      role: message.role,
      content: content
        || (reasoning ? "(see reasoning)" : "")
        || (tools.length || frames ? "(see tools)" : ""),
    };
    if (reasoning) turn.reasoning = reasoning;
    if (sql) turn.sql = sql;
    if (queries.length) turn.queries = queries;
    if (chart) turn.chart = chart;
    if (desk) turn.desk = desk;
    if (trades) turn.trades = trades;
    if (tools.length) turn.tools = tools;
    if (frames?.length) turn.frames = frames;
    if (typeof meta?.createdAt === "number" && Number.isFinite(meta.createdAt)) turn.ts = meta.createdAt;
    out.push(turn);
  }
  return coalesceAssistantShareTurns(out).map((turn) => (
    turn.role === "assistant" ? promoteReasoningTakeaway(turn) : turn
  ));
}
