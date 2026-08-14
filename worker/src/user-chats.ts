/**
 * D1 catalog of chats owned by a signed-in user.
 *
 * Unowned chats stay UUID-capability (anyone with the id can open the
 * CopilotAgent instance). Once a row exists in user_chats, the Worker
 * requires a session whose user_id matches — including after soft-delete,
 * so an owned DO never becomes world-readable again.
 */
import { getSessionUser } from "./auth";

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 120;
const LIST_LIMIT = 100;

export interface UserChatRow {
  chat_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export function parseChatId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return CHAT_ID_RE.test(id) ? id : null;
}

/** Newest activity first. Ties break on created_at, then chat_id, so the list does not jitter. */
export function compareUserChats(a: UserChatRow, b: UserChatRow): number {
  if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.chat_id < b.chat_id) return 1;
  if (a.chat_id > b.chat_id) return -1;
  return 0;
}

export function sortUserChats(rows: UserChatRow[]): UserChatRow[] {
  return [...rows].sort(compareUserChats);
}

export function titleFromMessages(messages: unknown, fallback?: string | null): string | null {
  if (typeof fallback === "string" && fallback.trim()) return fallback.trim().slice(0, TITLE_MAX);
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const rec = message as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (typeof rec.content === "string" && rec.content.trim()) return rec.content.trim().slice(0, TITLE_MAX);
  }
  return null;
}

export function copilotAgentChatId(pathname: string): string | null {
  const match = pathname.match(/^\/agents\/copilot-agent\/([^/]+)/);
  if (!match) return null;
  try {
    return parseChatId(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

interface OwnerRow {
  user_id: string;
  deleted_at: number | null;
}

export async function ownerOf(db: D1Database, chatId: string): Promise<OwnerRow | null> {
  return await db.prepare(
    "SELECT user_id, deleted_at FROM user_chats WHERE chat_id = ?1",
  ).bind(chatId).first<OwnerRow>();
}

/**
 * Gate CopilotAgent HTTP/WebSocket access. Returns a Response to send (401/403)
 * or null to allow the request through. Unowned chats are UUID-capability.
 * Session is loaded only after we know the chat is owned.
 */
export async function authorizeCopilotAgent(
  env: { SCHEMA_DB: D1Database; BETTER_AUTH_SECRET?: string; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string },
  req: Request,
): Promise<Response | null> {
  const chatId = copilotAgentChatId(new URL(req.url).pathname);
  if (!chatId) return null;
  const owner = await ownerOf(env.SCHEMA_DB, chatId);
  if (!owner) return null;
  const user = await getSessionUser(env, req);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (user.id !== owner.user_id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function listUserChats(db: D1Database, userId: string): Promise<UserChatRow[]> {
  const rows = await db.prepare(
    `SELECT chat_id, title, created_at, updated_at
     FROM user_chats
     WHERE user_id = ?1 AND deleted_at IS NULL
     ORDER BY updated_at DESC, created_at DESC, chat_id DESC
     LIMIT ?2`,
  ).bind(userId, LIST_LIMIT).all<UserChatRow>();
  return sortUserChats(rows.results ?? []);
}

export type ClaimResult =
  | { ok: true; chat_id: string; title: string | null; created: boolean }
  | { ok: false; status: 400 | 409; error: string };

/**
 * Catalog a chat onto the signed-in user.
 * Opening/claiming an already-owned row must not bump `updated_at` — that
 * timestamp is recency, and only a saved turn (`touch`) or an explicit rename
 * should move a row to the top of history.
 */
export async function claimChat(
  db: D1Database,
  userId: string,
  chatId: string,
  title: string | null,
  opts: { touch?: boolean } = {},
): Promise<ClaimResult> {
  const now = Date.now();
  const existing = await ownerOf(db, chatId);
  if (existing && existing.user_id !== userId) {
    return { ok: false, status: 409, error: "chat is owned by another user" };
  }
  if (existing) {
    const created = existing.deleted_at != null;
    if (opts.touch) {
      await db.prepare(
        `UPDATE user_chats
         SET deleted_at = NULL,
             updated_at = ?1,
             title = COALESCE(?2, title)
         WHERE chat_id = ?3 AND user_id = ?4`,
      ).bind(now, title, chatId, userId).run();
    } else {
      await db.prepare(
        `UPDATE user_chats
         SET deleted_at = NULL,
             title = COALESCE(?1, title)
         WHERE chat_id = ?2 AND user_id = ?3`,
      ).bind(title, chatId, userId).run();
    }
    const row = await db.prepare(
      "SELECT title FROM user_chats WHERE chat_id = ?1 AND user_id = ?2",
    ).bind(chatId, userId).first<{ title: string | null }>();
    return { ok: true, chat_id: chatId, title: row?.title ?? title, created };
  }
  await db.prepare(
    `INSERT INTO user_chats (chat_id, user_id, title, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, ?4, ?4, NULL)`,
  ).bind(chatId, userId, title, now).run();
  const row = await db.prepare(
    "SELECT title FROM user_chats WHERE chat_id = ?1 AND user_id = ?2",
  ).bind(chatId, userId).first<{ title: string | null }>();
  return { ok: true, chat_id: chatId, title: row?.title ?? title, created: true };
}

/** Best-effort catalog upsert used when a signed-in turn is captured. Never throws. */
export async function touchUserChat(
  db: D1Database,
  userId: string,
  chatId: string,
  title: string | null,
): Promise<void> {
  try {
    await claimChat(db, userId, chatId, title, { touch: true });
  } catch (error) {
    console.error("user_chats upsert failed", error);
  }
}

export async function renameChat(
  db: D1Database,
  userId: string,
  chatId: string,
  title: string,
): Promise<{ ok: true; title: string } | { ok: false; status: 400 | 404; error: string }> {
  const trimmed = title.trim().slice(0, TITLE_MAX);
  if (!trimmed) return { ok: false, status: 400, error: "title is required" };
  const result = await db.prepare(
    `UPDATE user_chats
     SET title = ?1, updated_at = ?2, deleted_at = NULL
     WHERE chat_id = ?3 AND user_id = ?4`,
  ).bind(trimmed, Date.now(), chatId, userId).run();
  if (!result.meta.changes) return { ok: false, status: 404, error: "not found" };
  return { ok: true, title: trimmed };
}

export async function deleteChat(
  db: D1Database,
  userId: string,
  chatId: string,
): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
  const result = await db.prepare(
    `UPDATE user_chats
     SET deleted_at = ?1, updated_at = ?1
     WHERE chat_id = ?2 AND user_id = ?3 AND deleted_at IS NULL`,
  ).bind(Date.now(), chatId, userId).run();
  if (!result.meta.changes) return { ok: false, status: 404, error: "not found" };
  return { ok: true };
}
