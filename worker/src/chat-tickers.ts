/**
 * Chat ↔ security graph. Links Copilot conversations to OpenFIGI-normalized
 * securities so chats that discuss the same underlying can be joined.
 */

import type { TickerIdentity } from "./figi";

export interface ChatTickerLink {
  chat_id: string;
  security_id: string;
  ticker: string;
  first_seen_at: number;
  last_seen_at: number;
  mention_count: number;
  name?: string | null;
  figi?: string | null;
  composite_figi?: string | null;
}

export async function linkChatTicker(
  db: D1Database,
  chatId: string,
  identity: TickerIdentity,
  now = Date.now(),
): Promise<ChatTickerLink> {
  const existing = await db.prepare(
    `SELECT chat_id, security_id, ticker, first_seen_at, last_seen_at, mention_count
     FROM chat_tickers WHERE chat_id = ?1 AND security_id = ?2`,
  ).bind(chatId, identity.security_id).first<{
    chat_id: string;
    security_id: string;
    ticker: string;
    first_seen_at: number;
    last_seen_at: number;
    mention_count: number;
  }>();

  if (existing) {
    await db.prepare(
      `UPDATE chat_tickers
       SET ticker = ?1, last_seen_at = ?2, mention_count = mention_count + 1
       WHERE chat_id = ?3 AND security_id = ?4`,
    ).bind(identity.ticker, now, chatId, identity.security_id).run();
    return {
      ...existing,
      ticker: identity.ticker,
      last_seen_at: now,
      mention_count: existing.mention_count + 1,
      name: identity.name,
      figi: identity.figi,
      composite_figi: identity.composite_figi,
    };
  }

  await db.prepare(
    `INSERT INTO chat_tickers (chat_id, security_id, ticker, first_seen_at, last_seen_at, mention_count)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)`,
  ).bind(chatId, identity.security_id, identity.ticker, now, now).run();

  return {
    chat_id: chatId,
    security_id: identity.security_id,
    ticker: identity.ticker,
    first_seen_at: now,
    last_seen_at: now,
    mention_count: 1,
    name: identity.name,
    figi: identity.figi,
    composite_figi: identity.composite_figi,
  };
}

export async function listChatTickers(db: D1Database, chatId: string): Promise<ChatTickerLink[]> {
  const rows = await db.prepare(
    `SELECT ct.chat_id, ct.security_id, ct.ticker, ct.first_seen_at, ct.last_seen_at, ct.mention_count,
            ti.name, ti.figi, ti.composite_figi
     FROM chat_tickers ct
     LEFT JOIN ticker_identities ti ON ti.ticker = ct.ticker
     WHERE ct.chat_id = ?1
     ORDER BY ct.last_seen_at DESC, ct.ticker ASC`,
  ).bind(chatId).all<{
    chat_id: string;
    security_id: string;
    ticker: string;
    first_seen_at: number;
    last_seen_at: number;
    mention_count: number;
    name: string | null;
    figi: string | null;
    composite_figi: string | null;
  }>();
  return (rows.results ?? []).map((row) => ({
    chat_id: row.chat_id,
    security_id: row.security_id,
    ticker: row.ticker,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    mention_count: row.mention_count,
    name: row.name,
    figi: row.figi,
    composite_figi: row.composite_figi,
  }));
}

export async function listSecurityChats(
  db: D1Database,
  securityId: string,
  limit = 20,
): Promise<ChatTickerLink[]> {
  const capped = Math.max(1, Math.min(100, limit));
  const rows = await db.prepare(
    `SELECT chat_id, security_id, ticker, first_seen_at, last_seen_at, mention_count
     FROM chat_tickers
     WHERE security_id = ?1
     ORDER BY last_seen_at DESC
     LIMIT ?2`,
  ).bind(securityId, capped).all<{
    chat_id: string;
    security_id: string;
    ticker: string;
    first_seen_at: number;
    last_seen_at: number;
    mention_count: number;
  }>();
  return rows.results ?? [];
}

/**
 * Collapse chat_tickers rows into ordered unique ticker lists per chat_id.
 * Rows must already be sorted by last_seen_at DESC (then ticker) so the first
 * occurrence of each symbol wins.
 */
export function groupTickersByChat(
  rows: { chat_id: string; ticker: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const ticker = row.ticker?.trim().toUpperCase();
    if (!row.chat_id || !ticker) continue;
    const list = out.get(row.chat_id) ?? [];
    if (!list.includes(ticker)) list.push(ticker);
    out.set(row.chat_id, list);
  }
  return out;
}

/** Batch-load tickers for many chats (timeline feed). Empty input → empty map. */
export async function listTickersForChats(
  db: D1Database,
  chatIds: string[],
): Promise<Map<string, string[]>> {
  const unique = [...new Set(chatIds.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) return new Map();

  const placeholders = unique.map((_, i) => `?${i + 1}`).join(", ");
  const rows = await db.prepare(
    `SELECT chat_id, ticker
     FROM chat_tickers
     WHERE chat_id IN (${placeholders})
     ORDER BY last_seen_at DESC, ticker ASC`,
  ).bind(...unique).all<{ chat_id: string; ticker: string }>();

  return groupTickersByChat(rows.results ?? []);
}
