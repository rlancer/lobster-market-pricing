/**
 * Bot suggested-trade performance — durable PnL book for personas like
 * @yololobster. Separate from signed-in paper cash accounts (no user_id / cash).
 */

import type { SuggestedTrades, TradeLeg } from "./copilot-trades";
import { formatTradeLeg, normalizeSuggestedTrades } from "./copilot-trades";
import { tradesFromToolArgs } from "./admin-trades";
import { parseToolArgsJson } from "./copilot-tool-events";
import {
  markStructure,
  suggestionKey,
  unrealizedPnl,
  type LakeSql,
  type PaperPositionStatus,
} from "./paper-portfolio";
import { parseHandle } from "./profiles";

export interface BotTradePositionRow {
  id: string;
  bot_handle: string;
  status: PaperPositionStatus;
  chat_id: string | null;
  share_id: string | null;
  run_id: string | null;
  suggestion_key: string;
  ticker: string;
  bias: string | null;
  conviction: string | null;
  structure: string;
  rationale: string | null;
  liquidity: string | null;
  legs_json: string;
  qty: number;
  entry_value: number | null;
  entry_marked_at: number | null;
  mark_value: number | null;
  marked_at: number | null;
  realized_pnl: number | null;
  opened_at: number;
  closed_at: number | null;
}

export interface BotTradePositionView {
  id: string;
  bot_handle: string;
  status: PaperPositionStatus;
  chat_id: string | null;
  share_id: string | null;
  run_id: string | null;
  suggestion_key: string;
  ticker: string;
  bias: string | null;
  conviction: string | null;
  structure: string;
  rationale: string | null;
  liquidity: string | null;
  legs: TradeLeg[];
  qty: number;
  entry_value: number | null;
  entry_marked_at: number | null;
  mark_value: number | null;
  marked_at: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  opened_at: number;
  opened_at_iso: string;
  closed_at: number | null;
  closed_at_iso: string | null;
}

export interface BotTradesBook {
  bot_handle: string;
  summary: {
    open_count: number;
    closed_count: number;
    open_pnl: number;
    realized_pnl: number;
  };
  positions: BotTradePositionView[];
}

export interface BotTrackResult {
  skipped: "empty" | "no_bot" | null;
  tracked: number;
  already: number;
  failed: number;
  errors: string[];
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `${prefix}_${out}`;
}

function iso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseLegsJson(raw: string): TradeLeg[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TradeLeg[];
  } catch {
    return [];
  }
}

function rowToView(row: BotTradePositionRow): BotTradePositionView {
  const entry = row.entry_value;
  const mark = row.mark_value;
  return {
    id: row.id,
    bot_handle: row.bot_handle,
    status: row.status,
    chat_id: row.chat_id,
    share_id: row.share_id,
    run_id: row.run_id,
    suggestion_key: row.suggestion_key,
    ticker: row.ticker,
    bias: row.bias,
    conviction: row.conviction,
    structure: row.structure,
    rationale: row.rationale,
    liquidity: row.liquidity,
    legs: parseLegsJson(row.legs_json),
    qty: row.qty,
    entry_value: entry,
    entry_marked_at: row.entry_marked_at,
    mark_value: mark,
    marked_at: row.marked_at,
    unrealized_pnl: row.status === "open" ? unrealizedPnl(entry, mark) : null,
    realized_pnl: row.realized_pnl,
    opened_at: row.opened_at,
    opened_at_iso: iso(row.opened_at)!,
    closed_at: row.closed_at,
    closed_at_iso: iso(row.closed_at),
  };
}

/**
 * Snapshot markable suggest_trades into the bot's performance book.
 */
export async function trackBotSuggestedTrades(
  db: D1Database,
  lake: LakeSql,
  botHandleRaw: string,
  chatId: string,
  payload: SuggestedTrades,
  opts?: { shareId?: string | null; runId?: string | null; now?: number; openedAt?: number },
): Promise<BotTrackResult> {
  const parsed = parseHandle(botHandleRaw);
  if (!parsed.ok) {
    return { skipped: "no_bot", tracked: 0, already: 0, failed: 0, errors: [] };
  }
  const botHandle = parsed.handle;
  const trades = payload.trades ?? [];
  if (trades.length === 0) {
    return { skipped: "empty", tracked: 0, already: 0, failed: 0, errors: [] };
  }

  const now = opts?.now ?? Date.now();
  const openedAt = opts?.openedAt ?? now;
  const chat = clip(chatId, 64);
  const shareId = opts?.shareId ? clip(opts.shareId, 64) : null;
  const runId = opts?.runId ? clip(opts.runId, 64) : null;

  let tracked = 0;
  let already = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!;
    const normalized = normalizeSuggestedTrades({ trades: [trade] });
    const idea = normalized?.trades[0];
    if (!idea?.legs?.length) {
      failed += 1;
      errors.push(`${trade.ticker ?? "?"}: needs concrete legs`);
      continue;
    }

    const key = suggestionKey(chat, i, idea);
    const existing = await db.prepare(
      `SELECT * FROM bot_trade_positions WHERE bot_handle = ?1 AND suggestion_key = ?2`,
    ).bind(botHandle, key).first<BotTradePositionRow>();
    if (existing) {
      already += 1;
      if (shareId && !existing.share_id) {
        await db.prepare(
          `UPDATE bot_trade_positions SET share_id = ?1 WHERE id = ?2`,
        ).bind(shareId, existing.id).run();
      }
      continue;
    }

    let mark: Awaited<ReturnType<typeof markStructure>>;
    try {
      mark = await markStructure(lake, idea.ticker, idea.legs, 1, now);
    } catch (error) {
      mark = {
        value: null,
        marked_at: now,
        incomplete: true,
        legs: [{
          instrument: "option",
          side: "buy",
          qty: 1,
          symbol: idea.ticker,
          mid: null,
          value: null,
          error: error instanceof Error ? error.message : "mark failed",
        }],
      };
    }
    // Bot book keeps the idea even when the lake cannot mark (e.g. expired 0DTE).
    // Personal paper cash requires a debit — bots do not.
    const markedAt = mark.value != null ? now : null;

    const id = newId("bpos");
    try {
      await db.prepare(
        `INSERT INTO bot_trade_positions (
          id, bot_handle, status, chat_id, share_id, run_id, suggestion_key,
          ticker, bias, conviction, structure, rationale, liquidity,
          legs_json, qty, entry_value, entry_marked_at, mark_value, marked_at,
          realized_pnl, opened_at, closed_at
        ) VALUES (
          ?1, ?2, 'open', ?3, ?4, ?5, ?6,
          ?7, ?8, ?9, ?10, ?11, ?12,
          ?13, 1, ?14, ?15, ?14, ?15,
          NULL, ?16, NULL
        )`,
      ).bind(
        id,
        botHandle,
        chat,
        shareId,
        runId,
        key,
        idea.ticker,
        idea.bias,
        idea.conviction,
        clip(idea.structure, 160),
        clip(idea.rationale, 480),
        idea.liquidity ? clip(idea.liquidity, 240) : null,
        JSON.stringify(idea.legs),
        mark.value,
        markedAt,
        openedAt,
      ).run();
      tracked += 1;
      if (mark.incomplete || mark.value == null) {
        errors.push(`${idea.ticker}: opened without mark (${mark.legs.find((l) => l.error)?.error ?? "incomplete"})`);
      }
    } catch {
      const raced = await db.prepare(
        `SELECT id FROM bot_trade_positions WHERE bot_handle = ?1 AND suggestion_key = ?2`,
      ).bind(botHandle, key).first<{ id: string }>();
      if (raced) already += 1;
      else {
        failed += 1;
        errors.push(`${idea.ticker}: insert failed`);
      }
    }
  }

  return { skipped: null, tracked, already, failed, errors };
}

/** Stamp share_id onto open bot positions for a chat after mintBotShare. */
export async function linkBotTradesShare(
  db: D1Database,
  chatId: string,
  shareId: string,
): Promise<number> {
  const result = await db.prepare(
    `UPDATE bot_trade_positions
     SET share_id = ?1
     WHERE chat_id = ?2 AND (share_id IS NULL OR share_id = '')`,
  ).bind(clip(shareId, 64), clip(chatId, 64)).run();
  return result.meta.changes ?? 0;
}

/** Pull SuggestedTrades payloads from a shared_chats.messages JSON blob. */
export function extractTradesFromShareMessages(messagesJson: string): SuggestedTrades[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SuggestedTrades[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const tradesRaw = (row as { trades?: unknown }).trades;
    if (!tradesRaw || typeof tradesRaw !== "object") continue;
    const normalized = normalizeSuggestedTrades(tradesRaw as { trades?: unknown; skip_reason?: unknown });
    if (normalized && normalized.trades.length > 0) out.push(normalized);
  }
  return out;
}

/**
 * Snapshot suggest_trades from recent public bot shares into the performance book.
 * Idempotent via suggestion_key; skips chats that already have positions.
 */
export async function backfillBotTradesFromShares(
  db: D1Database,
  lake: LakeSql,
  botHandleRaw: string,
  opts?: { limit?: number; now?: number },
): Promise<{ scanned: number; tracked: number; already: number; failed: number }> {
  const parsed = parseHandle(botHandleRaw);
  if (!parsed.ok) {
    return { scanned: 0, tracked: 0, already: 0, failed: 0 };
  }
  const botHandle = parsed.handle;
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 100);
  const now = opts?.now ?? Date.now();

  const shares = await db.prepare(
    `SELECT share_id, chat_id, run_id, created_at, messages
     FROM shared_chats
     WHERE bot_handle = ?1
       AND messages LIKE '%"legs"%'
       AND NOT EXISTS (
         SELECT 1 FROM bot_trade_positions p
         WHERE p.share_id = shared_chats.share_id OR p.chat_id = shared_chats.chat_id
         LIMIT 1
       )
     ORDER BY created_at DESC
     LIMIT ?2`,
  ).bind(botHandle, limit).all<{
    share_id: string;
    chat_id: string;
    run_id: string | null;
    created_at: number;
    messages: string;
  }>();

  let scanned = 0;
  let tracked = 0;
  let already = 0;
  let failed = 0;

  for (const share of shares.results ?? []) {
    const payloads = extractTradesFromShareMessages(share.messages);
    if (payloads.length === 0) continue;
    scanned += 1;
    for (const payload of payloads) {
      const result = await trackBotSuggestedTrades(
        db,
        lake,
        botHandle,
        share.chat_id,
        payload,
        {
          shareId: share.share_id,
          runId: share.run_id,
          now,
          openedAt: Number.isFinite(share.created_at) ? share.created_at : now,
        },
      );
      tracked += result.tracked;
      already += result.already;
      failed += result.failed;
    }
  }

  return { scanned, tracked, already, failed };
}

/**
 * Snapshot suggest_trades from copilot_tool_events for this bot's runs.
 * Covers shares that dropped `trades` under the byte budget, and unshared runs.
 */
export async function backfillBotTradesFromToolEvents(
  db: D1Database,
  lake: LakeSql,
  botHandleRaw: string,
  opts?: { limit?: number; now?: number },
): Promise<{ scanned: number; tracked: number; already: number; failed: number }> {
  const parsed = parseHandle(botHandleRaw);
  if (!parsed.ok) {
    return { scanned: 0, tracked: 0, already: 0, failed: 0 };
  }
  const botHandle = parsed.handle;
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 100);
  const now = opts?.now ?? Date.now();

  const events = await db.prepare(
    `SELECT e.event_id, e.chat_id, e.args_json, e.created_at, r.run_id, r.share_id
     FROM copilot_tool_events e
     INNER JOIN bot_runs r ON r.chat_id = e.chat_id AND r.handle = ?1
     WHERE e.tool_name = 'suggest_trades' AND e.ok = 1
       AND NOT EXISTS (
         SELECT 1 FROM bot_trade_positions p WHERE p.chat_id = e.chat_id LIMIT 1
       )
     ORDER BY e.created_at DESC
     LIMIT ?2`,
  ).bind(botHandle, limit).all<{
    event_id: string;
    chat_id: string;
    args_json: string;
    created_at: number;
    run_id: string;
    share_id: string | null;
  }>();

  let scanned = 0;
  let tracked = 0;
  let already = 0;
  let failed = 0;

  for (const event of events.results ?? []) {
    const ideas = tradesFromToolArgs(parseToolArgsJson(event.args_json));
    if (ideas.length === 0) continue;
    scanned += 1;
    const payload = normalizeSuggestedTrades({ trades: ideas });
    if (!payload || payload.trades.length === 0) continue;
    const result = await trackBotSuggestedTrades(
      db,
      lake,
      botHandle,
      event.chat_id,
      payload,
      {
        shareId: event.share_id,
        runId: event.run_id,
        now,
        openedAt: Number.isFinite(event.created_at) ? event.created_at : now,
      },
    );
    tracked += result.tracked;
    already += result.already;
    failed += result.failed;
  }

  return { scanned, tracked, already, failed };
}

export async function listBotTrades(
  db: D1Database,
  lake: LakeSql,
  botHandleRaw: string,
  opts?: {
    status?: "open" | "closed" | "all";
    refreshMarks?: boolean;
    limit?: number;
    backfill?: boolean;
  },
  now = Date.now(),
): Promise<BotTradesBook | null> {
  const parsed = parseHandle(botHandleRaw);
  if (!parsed.ok) return null;
  const botHandle = parsed.handle;
  const status = opts?.status ?? "open";
  const refresh = opts?.refreshMarks !== false;
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);

  if (opts?.backfill !== false) {
    try {
      // Shares first (when trades survived the byte budget), then tool events
      // for the common case where share JSON dropped trades.
      await backfillBotTradesFromShares(db, lake, botHandle, { now, limit: 15 });
      await backfillBotTradesFromToolEvents(db, lake, botHandle, { now, limit: 25 });
    } catch (error) {
      console.warn("bot trades backfill skipped", error);
    }
  }

  const rows = status === "all"
    ? await db.prepare(
      `SELECT * FROM bot_trade_positions WHERE bot_handle = ?1 ORDER BY opened_at DESC LIMIT ?2`,
    ).bind(botHandle, limit).all<BotTradePositionRow>()
    : await db.prepare(
      `SELECT * FROM bot_trade_positions WHERE bot_handle = ?1 AND status = ?2 ORDER BY opened_at DESC LIMIT ?3`,
    ).bind(botHandle, status, limit).all<BotTradePositionRow>();

  const positions = rows.results ?? [];
  const views: BotTradePositionView[] = [];

  for (const row of positions) {
    if (refresh && row.status === "open") {
      const legs = parseLegsJson(row.legs_json);
      if (legs.length) {
        try {
          const mark = await markStructure(lake, row.ticker, legs, row.qty, now);
          if (mark.value != null) {
            // First successful mark becomes entry when the idea opened unmarkable.
            const entryValue = row.entry_value ?? mark.value;
            const entryMarkedAt = row.entry_marked_at ?? now;
            await db.prepare(
              `UPDATE bot_trade_positions
               SET mark_value = ?1, marked_at = ?2,
                   entry_value = COALESCE(entry_value, ?1),
                   entry_marked_at = COALESCE(entry_marked_at, ?2)
               WHERE id = ?3`,
            ).bind(mark.value, now, row.id).run();
            row.mark_value = mark.value;
            row.marked_at = now;
            row.entry_value = entryValue;
            row.entry_marked_at = entryMarkedAt;
          }
        } catch {
          // Keep last mark.
        }
      }
    }
    views.push(rowToView(row));
  }

  // Counts / PnL across the filtered list (and full open/closed tallies for summary).
  const tallies = await db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
       SUM(CASE WHEN status = 'closed' THEN COALESCE(realized_pnl, 0) ELSE 0 END) AS realized_pnl
     FROM bot_trade_positions WHERE bot_handle = ?1`,
  ).bind(botHandle).first<{
    open_count: number | null;
    closed_count: number | null;
    realized_pnl: number | null;
  }>();

  let openPnl = 0;
  for (const p of views) {
    if (p.status === "open" && p.unrealized_pnl != null) openPnl += p.unrealized_pnl;
  }

  // When viewing closed-only, still surface open PnL from a cheap open-position pass.
  if (status === "closed" && Number(tallies?.open_count ?? 0) > 0) {
    const openRows = await db.prepare(
      `SELECT entry_value, mark_value FROM bot_trade_positions
       WHERE bot_handle = ?1 AND status = 'open' AND entry_value IS NOT NULL AND mark_value IS NOT NULL`,
    ).bind(botHandle).all<{ entry_value: number; mark_value: number }>();
    openPnl = 0;
    for (const r of openRows.results ?? []) {
      const pnl = unrealizedPnl(r.entry_value, r.mark_value);
      if (pnl != null) openPnl += pnl;
    }
  }

  return {
    bot_handle: botHandle,
    summary: {
      open_count: Number(tallies?.open_count ?? 0),
      closed_count: Number(tallies?.closed_count ?? 0),
      open_pnl: openPnl,
      realized_pnl: Number(tallies?.realized_pnl ?? 0),
    },
    positions: views,
  };
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/** Compact text for Copilot tool output. */
export function formatBotTradesSummary(book: BotTradesBook): string {
  const { summary, positions, bot_handle } = book;
  const lines = [
    `@${bot_handle} suggested trades`,
    `Open ${summary.open_count} · Closed ${summary.closed_count} · Open PnL ${money(summary.open_pnl)} · Realized ${money(summary.realized_pnl)}`,
  ];
  if (positions.length === 0) {
    lines.push("No positions in this filter.");
    return lines.join("\n");
  }
  for (const p of positions.slice(0, 40)) {
    const pnl = p.status === "open" ? p.unrealized_pnl : p.realized_pnl;
    const legs = p.legs.length ? p.legs.map(formatTradeLeg).join(", ") : "no legs";
    const share = p.share_id ? ` · share ${p.share_id}` : "";
    lines.push(
      `- ${p.ticker} · ${p.status} · ${p.structure} · entry ${money(p.entry_value)} · mark ${money(p.mark_value)} · PnL ${money(pnl)} · ${legs}${share}`,
    );
  }
  if (positions.length > 40) lines.push(`…and ${positions.length - 40} more`);
  return lines.join("\n");
}
