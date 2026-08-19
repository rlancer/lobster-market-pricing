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
/** Catalog / share title ceiling (chars). Longer first turns are clipped. */
export const TITLE_MAX = 120;
const LIST_LIMIT = 100;

/**
 * Cap a display title without cutting mid-word when possible.
 *
 * Prefer the opening sentence when it fits under `max` (bot prompts often
 * lead with a short question, then instructions). Otherwise break on the last
 * word boundary and append an ellipsis so the UI never ends on "and th".
 */
export function clipTitle(text: string, max = TITLE_MAX): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= max) return trimmed;

  const sentence = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentence && sentence[1].length >= 12 && sentence[1].length <= max) {
    return sentence[1];
  }

  const budget = max - 1; // room for …
  let slice = trimmed.slice(0, budget);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.min(24, Math.floor(budget * 0.4))) {
    slice = slice.slice(0, lastSpace);
  }
  return `${slice.trimEnd()}…`;
}

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

/** Non-empty catalog title, or null. History never lists untitled shells. */
export function historyTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const clipped = clipTitle(title);
  return clipped || null;
}

/**
 * Prefer a saved title when present; otherwise the first user turn, clipped
 * for display (sentence / word boundary — never a mid-word hard cut).
 */
export function titleFromMessages(messages: unknown, fallback?: string | null): string | null {
  const named = historyTitle(fallback);
  if (named) return named;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const rec = message as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (typeof rec.content === "string" && rec.content.trim()) {
      return clipTitle(rec.content);
    }
  }
  return null;
}

/**
 * Prefer a saved/LLM title when it is not just an auto clip of the first user
 * turn. Heal legacy mid-word `slice(0, 120)` rows from the intact first turn.
 */
export function shareDisplayTitle(messages: unknown, stored?: string | null): string | null {
  const first = firstUserContent(messages);
  const named = historyTitle(stored);
  if (named && !isAutoDerivedTitle(named, first)) return named;
  if (first) return clipTitle(first) || null;
  return named;
}

/** First non-empty user turn content, or null. */
export function firstUserContent(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const rec = message as Record<string, unknown>;
    if (rec.role !== "user") continue;
    if (typeof rec.content === "string" && rec.content.trim()) return rec.content.trim();
  }
  return null;
}

/**
 * True when `stored` looks like an auto clip of the first user turn (including
 * legacy mid-word `slice(0, 120)` without an ellipsis, and the verbatim prompt
 * used as the title). Manual renames and LLM headlines should return false.
 */
export function isAutoDerivedTitle(stored: string | null | undefined, firstUser: string | null | undefined): boolean {
  if (typeof stored !== "string" || !stored.trim()) return false;
  if (typeof firstUser !== "string" || !firstUser.trim()) return false;
  const named = stored.trim().replace(/\s+/g, " ");
  const raw = firstUser.trim().replace(/\s+/g, " ");
  // Short prompts often land as the full title (no clip) — still auto-derived.
  if (named.toLowerCase() === raw.toLowerCase()) return true;
  if (named === clipTitle(raw)) return true;
  if (named.endsWith("…")) return false;
  if (raw.startsWith(named) && raw.length > named.length && named.length >= 80) return true;
  return false;
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

export type ChatTranscriptBackup = {
  source: "pending_history" | "share" | null;
  title: string | null;
  messages: Record<string, unknown>[];
};

/**
 * Best-effort transcript restore for an owned chat whose Durable Object is empty.
 * Prefers the newest pending history payload (full conversation snapshot per turn),
 * then falls back to the newest share row for the same chat_id.
 */
export async function loadOwnedChatTranscript(
  db: D1Database,
  chatId: string,
): Promise<ChatTranscriptBackup> {
  const pending = await db.prepare(
    `SELECT payload FROM pending_chat_history
     WHERE chat_id = ?1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).bind(chatId).first<{ payload: string }>();
  if (pending?.payload) {
    try {
      const parsed = JSON.parse(pending.payload) as { messages?: unknown; title?: unknown };
      const messages = coerceTranscriptMessages(parsed.messages);
      if (messages.length > 0) {
        return {
          source: "pending_history",
          title: historyTitle(typeof parsed.title === "string" ? parsed.title : null),
          messages,
        };
      }
    } catch {
      /* fall through */
    }
  }

  const share = await db.prepare(
    `SELECT title, messages FROM shared_chats
     WHERE chat_id = ?1
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(chatId).first<{ title: string | null; messages: string }>();
  if (share?.messages) {
    try {
      const messages = coerceTranscriptMessages(JSON.parse(share.messages));
      if (messages.length > 0) {
        return {
          source: "share",
          title: historyTitle(share.title),
          messages,
        };
      }
    } catch {
      /* fall through */
    }
  }

  return { source: null, title: null, messages: [] };
}

function coerceTranscriptMessages(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return coerceTranscriptMessages(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const role = row.role;
    const content = row.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push(row);
  }
  return out;
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
     WHERE user_id = ?1
       AND deleted_at IS NULL
       AND title IS NOT NULL
       AND TRIM(title) != ''
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
 *
 * A new row is created only when there is a real title (first user turn).
 * Untitled claims are rejected so blank "Untitled chat" shells never land
 * in the sidebar. Soft-deleted empty rows stay deleted unless a title arrives.
 */
export async function claimChat(
  db: D1Database,
  userId: string,
  chatId: string,
  title: string | null,
  opts: { touch?: boolean } = {},
): Promise<ClaimResult> {
  const named = historyTitle(title);
  const now = Date.now();
  const existing = await ownerOf(db, chatId);
  if (existing && existing.user_id !== userId) {
    return { ok: false, status: 409, error: "chat is owned by another user" };
  }
  if (!existing) {
    if (!named) return { ok: false, status: 400, error: "title is required" };
    await db.prepare(
      `INSERT INTO user_chats (chat_id, user_id, title, created_at, updated_at, deleted_at)
       VALUES (?1, ?2, ?3, ?4, ?4, NULL)`,
    ).bind(chatId, userId, named, now).run();
    return { ok: true, chat_id: chatId, title: named, created: true };
  }
  const resurrect = existing.deleted_at != null;
  if (resurrect && !named) {
    const row = await db.prepare(
      "SELECT title FROM user_chats WHERE chat_id = ?1 AND user_id = ?2",
    ).bind(chatId, userId).first<{ title: string | null }>();
    return { ok: true, chat_id: chatId, title: historyTitle(row?.title ?? null), created: false };
  }
  if (!named && !opts.touch) {
    const row = await db.prepare(
      "SELECT title FROM user_chats WHERE chat_id = ?1 AND user_id = ?2",
    ).bind(chatId, userId).first<{ title: string | null }>();
    return { ok: true, chat_id: chatId, title: historyTitle(row?.title ?? null), created: false };
  }
  if (opts.touch) {
    await db.prepare(
      `UPDATE user_chats
       SET deleted_at = NULL,
           updated_at = ?1,
           title = COALESCE(?2, title)
       WHERE chat_id = ?3 AND user_id = ?4`,
    ).bind(now, named, chatId, userId).run();
  } else {
    await db.prepare(
      `UPDATE user_chats
       SET deleted_at = NULL,
           title = COALESCE(?1, title)
       WHERE chat_id = ?2 AND user_id = ?3`,
    ).bind(named, chatId, userId).run();
  }
  const row = await db.prepare(
    "SELECT title FROM user_chats WHERE chat_id = ?1 AND user_id = ?2",
  ).bind(chatId, userId).first<{ title: string | null }>();
  return { ok: true, chat_id: chatId, title: row?.title ?? named, created: resurrect };
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
  const trimmed = clipTitle(title);
  if (!trimmed) return { ok: false, status: 400, error: "title is required" };
  const result = await db.prepare(
    `UPDATE user_chats
     SET title = ?1, updated_at = ?2, deleted_at = NULL
     WHERE chat_id = ?3 AND user_id = ?4`,
  ).bind(trimmed, Date.now(), chatId, userId).run();
  if (!result.meta.changes) return { ok: false, status: 404, error: "not found" };
  return { ok: true, title: trimmed };
}

/**
 * Overwrite a chat title when the current value is still auto-derived (clip /
 * legacy truncate). Never clobbers an explicit rename. Best-effort.
 */
export async function applyGeneratedChatTitle(
  db: D1Database,
  chatId: string,
  title: string | null,
  firstUser: string | null,
): Promise<void> {
  const named = historyTitle(title);
  if (!named) return;
  try {
    const row = await db.prepare(
      `SELECT title FROM user_chats WHERE chat_id = ?1 AND deleted_at IS NULL`,
    ).bind(chatId).first<{ title: string | null }>();
    if (!row) return;
    if (row.title && !isAutoDerivedTitle(row.title, firstUser)) return;
    await db.prepare(
      `UPDATE user_chats SET title = ?1, updated_at = ?2 WHERE chat_id = ?3 AND deleted_at IS NULL`,
    ).bind(named, Date.now(), chatId).run();
  } catch (error) {
    console.error("applyGeneratedChatTitle failed", error);
  }
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
