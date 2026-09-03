/**
 * Fork a public shared chat into a new owned chat conversation.
 *
 * The share snapshot is the source of truth (immutable). We mint a fresh chat
 * UUID, seed its Durable Object via persistMessages (no LLM turn), claim it
 * onto the signed-in user, and return the id so the client can send the
 * follow-up question. Login + public handle are required so the follow-up can
 * be attributed when the forked chat is shared back to the timeline.
 */
import type { UIMessage } from "ai";
import { getHandle, getUserProfile, publicName, type UserProfileRow } from "./profiles";
import { avatarUrlFor } from "./avatars";
import { claimChat, clipTitle, parseChatId, type ClaimResult } from "./user-chats";

const SHARE_ID_RE = /^[0-9A-Za-z]{1,48}$/;
/** Follow-up question ceiling — matches chat composer practical limits. */
export const FORK_QUESTION_MAX = 4_000;

export type ShareAuthor = {
  handle: string;
  name: string;
  is_bot?: boolean;
  avatar_url?: string | null;
};

export type ChatForkMeta = {
  parent_share_id: string;
  fork_seed_count: number;
};

export type SeedableTurn = {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sql?: string;
  chart?: unknown;
  desk?: unknown;
  trades?: unknown;
  tools?: unknown;
  frames?: unknown;
  ts?: number;
};

export type ForkAgent = {
  seedTranscript: (input: {
    messages: SeedableTurn[];
  }) => Promise<{ ok: true; count: number } | { ok: false; error: string }>;
};

export function parseShareId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return SHARE_ID_RE.test(id) ? id : null;
}

export function parseForkQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const question = value.trim();
  if (!question || question.length > FORK_QUESTION_MAX) return null;
  return question;
}

/** Flatten share JSON into seedable turns (drop empty shells). */
export function turnsFromShareMessages(raw: unknown): SeedableTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: SeedableTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    const reasoning = typeof rec.reasoning === "string" ? rec.reasoning.trim() : "";
    const sql = typeof rec.sql === "string" ? rec.sql.trim() : "";
    const hasExtra = Boolean(
      rec.chart || rec.desk || rec.trades
      || (Array.isArray(rec.tools) && rec.tools.length)
      || (Array.isArray(rec.frames) && rec.frames.length)
      || reasoning
      || sql,
    );
    if (!content && !hasExtra) continue;
    const turn: SeedableTurn = {
      role,
      content: content || (reasoning ? "(see reasoning)" : ""),
    };
    if (reasoning) turn.reasoning = reasoning;
    if (sql) turn.sql = sql;
    if (rec.chart) turn.chart = rec.chart;
    if (rec.desk) turn.desk = rec.desk;
    if (rec.trades) turn.trades = rec.trades;
    if (Array.isArray(rec.tools) && rec.tools.length) turn.tools = rec.tools;
    if (Array.isArray(rec.frames) && rec.frames.length) turn.frames = rec.frames;
    if (typeof rec.ts === "number" && Number.isFinite(rec.ts)) turn.ts = rec.ts;
    out.push(turn);
  }
  return out;
}

/** Convert share turns into AI SDK UIMessages for Durable Object seeding. */
export function uiMessagesFromSeedTurns(turns: SeedableTurn[]): UIMessage[] {
  return turns.map((turn) => {
    const parts: UIMessage["parts"] = [];
    if (turn.reasoning) {
      parts.push({ type: "reasoning", text: turn.reasoning });
    }
    parts.push({ type: "text", text: turn.content });
    const metadata: Record<string, unknown> = {
      model: "",
      createdAt: turn.ts ?? Date.now(),
    };
    if (turn.sql) metadata.sql = turn.sql;
    if (turn.chart) metadata.chart = turn.chart;
    if (turn.desk) metadata.desk = turn.desk;
    if (turn.trades) metadata.trades = turn.trades;
    if (turn.frames) metadata.frames = turn.frames;
    return {
      id: crypto.randomUUID(),
      role: turn.role,
      parts,
      metadata,
    } as UIMessage;
  });
}

/** Compact author blob stamped onto share/timeline user turns. */
export function capShareAuthor(raw: unknown): ShareAuthor | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const handle = typeof rec.handle === "string" ? rec.handle.trim().toLowerCase() : "";
  if (!/^[a-z][a-z0-9_]{2,23}$/.test(handle)) return undefined;
  const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 80) : "";
  const author: ShareAuthor = {
    handle,
    name: name || handle,
  };
  if (rec.is_bot === true) author.is_bot = true;
  if (typeof rec.avatar_url === "string" && rec.avatar_url.trim()) {
    author.avatar_url = rec.avatar_url.trim().slice(0, 200);
  } else if (rec.avatar_url === null) {
    author.avatar_url = null;
  }
  return author;
}

/**
 * Stamp per-turn authors for a forked share: seeded prefix keeps the parent
 * author; later user turns belong to the forker.
 */
export function stampForkAuthors(
  messages: Record<string, unknown>[],
  seedCount: number,
  parent: ShareAuthor | null,
  forker: ShareAuthor | null,
): void {
  const seed = Math.max(0, Math.floor(seedCount));
  for (let i = 0; i < messages.length; i++) {
    const row = messages[i];
    if (!row || row.role !== "user") continue;
    const existing = capShareAuthor(row.author);
    if (existing) continue;
    const author = i < seed ? parent : forker;
    if (author) row.author = { ...author };
  }
}

export async function resolveShareAuthor(
  db: D1Database,
  shareId: string,
): Promise<ShareAuthor | null> {
  const human = await db.prepare(
    `SELECT pr.handle AS handle, pr.display_name AS display_name,
            pr.avatar_key AS avatar_key, pr.updated_at AS updated_at,
            u.name AS oauth_name, pr.user_id AS user_id
     FROM share_owners so
     JOIN user_profiles pr ON pr.user_id = so.user_id
     JOIN "user" u ON u.id = so.user_id
     WHERE so.share_id = ?1`,
  ).bind(shareId).first<{
    handle: string;
    display_name: string | null;
    avatar_key: string | null;
    updated_at: number;
    oauth_name: string;
    user_id: string;
  }>();
  if (human) {
    return {
      handle: human.handle,
      name: publicName(human.display_name, human.oauth_name),
      is_bot: false,
      avatar_url: avatarUrlFor(human.user_id, human.avatar_key, human.updated_at),
    };
  }

  const bot = await db.prepare(
    `SELECT b.handle AS handle, b.display_name AS name
     FROM shared_chats s
     JOIN bot_profiles b ON b.handle = s.bot_handle AND b.enabled = 1
     WHERE s.share_id = ?1 AND s.bot_handle IS NOT NULL`,
  ).bind(shareId).first<{ handle: string; name: string }>();
  if (bot) {
    return { handle: bot.handle, name: bot.name, is_bot: true, avatar_url: null };
  }

  // Timeline-listed human posts always have share_owners after publish; older
  // rows may only appear via timeline_posts — fall back for attribution.
  const listed = await db.prepare(
    `SELECT pr.handle AS handle, pr.display_name AS display_name,
            pr.avatar_key AS avatar_key, pr.updated_at AS updated_at,
            u.name AS oauth_name, pr.user_id AS user_id
     FROM timeline_posts p
     JOIN user_profiles pr ON pr.user_id = p.user_id
     JOIN "user" u ON u.id = p.user_id
     WHERE p.share_id = ?1`,
  ).bind(shareId).first<{
    handle: string;
    display_name: string | null;
    avatar_key: string | null;
    updated_at: number;
    oauth_name: string;
    user_id: string;
  }>();
  if (listed) {
    return {
      handle: listed.handle,
      name: publicName(listed.display_name, listed.oauth_name),
      is_bot: false,
      avatar_url: avatarUrlFor(listed.user_id, listed.avatar_key, listed.updated_at),
    };
  }
  return null;
}

export async function getChatForkMeta(
  db: D1Database,
  chatId: string,
): Promise<ChatForkMeta | null> {
  const id = parseChatId(chatId);
  if (!id) return null;
  const row = await db.prepare(
    `SELECT parent_share_id, fork_seed_count
     FROM user_chats
     WHERE chat_id = ?1 AND parent_share_id IS NOT NULL`,
  ).bind(id).first<{ parent_share_id: string; fork_seed_count: number | null }>();
  if (!row?.parent_share_id) return null;
  return {
    parent_share_id: row.parent_share_id,
    fork_seed_count: typeof row.fork_seed_count === "number" ? row.fork_seed_count : 0,
  };
}

export function authorFromProfile(
  userId: string,
  profile: UserProfileRow | null,
  oauthName: string | null | undefined,
): ShareAuthor | null {
  const handle = profile?.handle?.trim().toLowerCase();
  if (!handle) return null;
  return {
    handle,
    name: publicName(profile?.display_name, oauthName),
    is_bot: false,
    avatar_url: avatarUrlFor(userId, profile?.avatar_key ?? null, profile?.updated_at ?? null),
  };
}

export type ForkResult =
  | {
    ok: true;
    chat_id: string;
    title: string;
    parent_share_id: string;
    parent_author: ShareAuthor | null;
    fork_seed_count: number;
    question: string;
  }
  | { ok: false; status: 400 | 401 | 404 | 409; error: string };

/**
 * Create an owned chat seeded from a public share. Caller supplies a DO stub
 * factory so this module stays free of Env/wrangler types.
 */
export async function forkChatFromShare(args: {
  db: D1Database;
  userId: string;
  oauthName?: string | null;
  shareId: string;
  question: string;
  getAgent: (chatId: string) => ForkAgent;
}): Promise<ForkResult> {
  const shareId = parseShareId(args.shareId);
  if (!shareId) return { ok: false, status: 400, error: "share_id is required" };
  const question = parseForkQuestion(args.question);
  if (!question) {
    return {
      ok: false,
      status: 400,
      error: `question is required (max ${FORK_QUESTION_MAX} chars)`,
    };
  }

  const handle = await getHandle(args.db, args.userId);
  if (!handle) return { ok: false, status: 400, error: "handle is required" };

  const share = await args.db.prepare(
    `SELECT share_id, chat_id, title, messages, expires_at, bot_handle
     FROM shared_chats WHERE share_id = ?1`,
  ).bind(shareId).first<{
    share_id: string;
    chat_id: string;
    title: string | null;
    messages: string;
    expires_at: number | null;
    bot_handle: string | null;
  }>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) {
    return { ok: false, status: 404, error: "not found" };
  }

  let parsed: unknown = [];
  try {
    parsed = JSON.parse(share.messages);
  } catch {
    parsed = [];
  }
  const turns = turnsFromShareMessages(parsed);
  if (turns.length === 0) {
    return { ok: false, status: 400, error: "share has no messages to continue" };
  }

  const chatId = crypto.randomUUID();
  const agent = args.getAgent(chatId);
  const seeded = await agent.seedTranscript({ messages: turns });
  if (!seeded.ok) {
    return { ok: false, status: 409, error: seeded.error || "could not seed chat" };
  }

  const title = clipTitle(question) || "Follow-up";
  const claimed: ClaimResult = await claimChat(args.db, args.userId, chatId, title, { touch: true });
  if (!claimed.ok) {
    return { ok: false, status: claimed.status, error: claimed.error };
  }

  await args.db.prepare(
    `UPDATE user_chats
     SET parent_share_id = ?1, fork_seed_count = ?2
     WHERE chat_id = ?3 AND user_id = ?4`,
  ).bind(shareId, seeded.count, chatId, args.userId).run();

  const parentAuthor = await resolveShareAuthor(args.db, shareId);
  return {
    ok: true,
    chat_id: chatId,
    title: claimed.title ?? title,
    parent_share_id: shareId,
    parent_author: parentAuthor,
    fork_seed_count: seeded.count,
    question,
  };
}
