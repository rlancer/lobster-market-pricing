/**
 * Admin directory of Copilot suggested trades.
 *
 * Source of truth: successful `suggest_trades` rows in `copilot_tool_events`
 * (same 30-day retention as tool-call debug). Lake chat_history strips tools;
 * shared_chats only keeps trades that were shared. Tool events cover every
 * successful suggest_trades call — shared or not.
 */
import {
  normalizeSuggestedTrades,
  type SuggestedTrade,
  type TradeBias,
  type TradeConviction,
  type TradeLeg,
} from "./copilot-trades";
import { parseToolArgsJson, TOOL_EVENT_ADMIN_LIMIT_MAX } from "./copilot-tool-events";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = TOOL_EVENT_ADMIN_LIMIT_MAX;

export interface AdminSuggestedTrade {
  id: string;
  event_id: string;
  chat_id: string;
  share_id: string | null;
  bot_handle: string | null;
  created_at: number;
  created_at_iso: string;
  model: string | null;
  ticker: string;
  bias: TradeBias;
  conviction: TradeConviction;
  structure: string;
  legs: TradeLeg[] | null;
  rationale: string;
  liquidity: string | null;
}

export interface AdminSuggestedTradesResult {
  ok: true;
  limit: number;
  before: string | null;
  items: AdminSuggestedTrade[];
  next_before: string | null;
  as_of: string;
}

type ShareHint = { share_id: string; bot_handle: string | null };

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function clampTradeListLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return clamp(Math.floor(n), 1, MAX_LIMIT);
}

/**
 * Pull concrete trade ideas from a suggest_trades tool-args payload.
 * Skips truncated / malformed / empty (no-lean) payloads.
 */
export function tradesFromToolArgs(args: unknown): SuggestedTrade[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const rec = args as Record<string, unknown>;
  if (rec._truncated || rec._error) return [];
  const normalized = normalizeSuggestedTrades(rec as { trades?: unknown; skip_reason?: unknown });
  return normalized?.trades ?? [];
}

export function flattenEventTrades(input: {
  event_id: string;
  chat_id: string;
  model: string | null;
  created_at: number;
  args: unknown;
  share_id?: string | null;
  bot_handle?: string | null;
}): AdminSuggestedTrade[] {
  const trades = tradesFromToolArgs(input.args);
  const createdAt = Number.isFinite(input.created_at) ? Math.round(input.created_at) : Date.now();
  return trades.map((trade, index) => ({
    id: `${input.event_id}:${index}`,
    event_id: input.event_id,
    chat_id: input.chat_id,
    share_id: input.share_id ?? null,
    bot_handle: input.bot_handle ?? null,
    created_at: createdAt,
    created_at_iso: new Date(createdAt).toISOString(),
    model: input.model,
    ticker: trade.ticker,
    bias: trade.bias,
    conviction: trade.conviction,
    structure: trade.structure,
    legs: trade.legs?.length ? trade.legs : null,
    rationale: trade.rationale,
    liquidity: trade.liquidity ?? null,
  }));
}

/** Newest share_id / bot_handle per chat_id (for admin deep-links). */
export async function loadShareHintsForChats(
  db: D1Database,
  chatIds: string[],
): Promise<Map<string, ShareHint>> {
  const unique = [...new Set(chatIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, ShareHint>();
  if (unique.length === 0) return out;

  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const result = await db
      .prepare(
        `SELECT chat_id, share_id, bot_handle, created_at
         FROM shared_chats
         WHERE chat_id IN (${placeholders})
         ORDER BY created_at DESC`,
      )
      .bind(...chunk)
      .all<{ chat_id: string; share_id: string; bot_handle: string | null; created_at: number }>();
    for (const row of result.results ?? []) {
      // First row per chat_id wins (newest) — SQL is ordered DESC.
      if (!out.has(row.chat_id)) {
        out.set(row.chat_id, {
          share_id: row.share_id,
          bot_handle: row.bot_handle ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * Newest-first suggested trades from successful suggest_trades tool events.
 * `limit` caps tool events scanned (each event contributes 0–3 trade rows).
 * `before` is an ISO created_at cursor on the tool-event timeline.
 */
export async function listAdminSuggestedTrades(
  db: D1Database,
  opts?: { limit?: number; before?: string | null },
): Promise<AdminSuggestedTradesResult> {
  const limit = clampTradeListLimit(opts?.limit);
  const beforeIso =
    opts?.before && Number.isFinite(Date.parse(opts.before)) ? opts.before : null;
  const beforeMs = beforeIso ? Date.parse(beforeIso) : null;

  const where = ["tool_name = ?1", "ok = 1"];
  const bindings: (string | number)[] = ["suggest_trades"];
  if (beforeMs != null) {
    where.push(`created_at < ?${bindings.length + 1}`);
    bindings.push(beforeMs);
  }
  bindings.push(limit);

  const rows = await db
    .prepare(
      `SELECT event_id, chat_id, args_json, model, created_at
       FROM copilot_tool_events
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, event_id DESC
       LIMIT ?${bindings.length}`,
    )
    .bind(...bindings)
    .all<{
      event_id: string;
      chat_id: string;
      args_json: string;
      model: string | null;
      created_at: number;
    }>();

  const events = rows.results ?? [];
  const shares = await loadShareHintsForChats(
    db,
    events.map((e) => e.chat_id),
  );

  const items: AdminSuggestedTrade[] = [];
  for (const event of events) {
    const hint = shares.get(event.chat_id);
    items.push(
      ...flattenEventTrades({
        event_id: event.event_id,
        chat_id: event.chat_id,
        model: event.model ?? null,
        created_at: event.created_at,
        args: parseToolArgsJson(event.args_json),
        share_id: hint?.share_id ?? null,
        bot_handle: hint?.bot_handle ?? null,
      }),
    );
  }

  const next_before =
    events.length > 0
      ? new Date(events[events.length - 1]!.created_at).toISOString()
      : null;

  return {
    ok: true,
    limit,
    before: beforeIso,
    items,
    next_before: events.length >= limit ? next_before : null,
    as_of: new Date().toISOString(),
  };
}
