/**
 * Public timeline of opted-in chat shares.
 *
 * Unlisted shares (shared_chats) stay a capability URL. A signed-in author
 * with a handle can POST /api/timeline to list that share on GET /api/timeline
 * (the home feed). DELETE removes the listing; the share link still works.
 */
import { getSessionUser, type AuthEnv } from "./auth";
import { getHandle, parseHandle } from "./profiles";

const SHARE_ID_RE = /^[0-9A-Za-z]{1,48}$/;
const LIST_DEFAULT = 30;
const LIST_MAX = 50;
/** Safety ceiling for a single first-message preview (not a display truncate). */
export const EXCERPT_MAX = 100_000;

export interface TimelineEnv extends AuthEnv {
  SCHEMA_DB: D1Database;
}

function json(data: unknown, status = 200, cache: "public" | "private" = "public"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cache === "private" ? "private, no-store" : "public, max-age=15",
    },
  });
}

function messageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Timeline preview body: the first full assistant answer, else the first user
 * turn, else the title. Keeps paragraph breaks so the feed can render the
 * message expanded; only a large safety ceiling applies.
 */
export function excerptFromMessages(messages: unknown, title: string | null): string {
  const rows = Array.isArray(messages) ? messages : [];
  let text = "";
  for (const row of rows) {
    const rec = messageRecord(row);
    if (rec?.role === "assistant" && typeof rec.content === "string" && rec.content.trim()) {
      text = rec.content;
      break;
    }
  }
  if (!text) {
    for (const row of rows) {
      const rec = messageRecord(row);
      if (rec?.role === "user" && typeof rec.content === "string" && rec.content.trim()) {
        text = rec.content;
        break;
      }
    }
  }
  if (!text && typeof title === "string") text = title;
  // Trim edges and collapse runs of spaces/tabs, but keep newlines so markdown
  // and multi-paragraph answers stay readable on the infinite-scroll feed.
  const normalized = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= EXCERPT_MAX) return normalized;
  return normalized.slice(0, EXCERPT_MAX - 1).trimEnd() + "…";
}

/**
 * First chat turn for the feed: the opening user question (when present) plus
 * the first assistant answer — same bubble layout as /share and /chat. Falls
 * back to a lone user turn or a title-only assistant stub.
 */
export function previewMessagesFromShare(messages: unknown, title: string | null = null): Record<string, unknown>[] {
  const rows = Array.isArray(messages) ? messages : [];
  let assistantIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const rec = messageRecord(rows[i]);
    if (rec?.role === "assistant" && (
      (typeof rec.content === "string" && rec.content.trim())
      || (typeof rec.sql === "string" && rec.sql.trim())
      || (typeof rec.reasoning === "string" && rec.reasoning.trim())
    )) {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex >= 0) {
    const out: Record<string, unknown>[] = [];
    if (assistantIndex > 0) {
      const prev = messageRecord(rows[assistantIndex - 1]);
      if (prev?.role === "user") {
        const user = slimPreviewMessage(prev);
        if (user) out.push(user);
      }
    }
    const assistant = slimPreviewMessage(messageRecord(rows[assistantIndex])!);
    if (assistant) out.push(assistant);
    return out;
  }
  for (const row of rows) {
    const rec = messageRecord(row);
    if (rec?.role === "user") {
      const user = slimPreviewMessage(rec);
      if (user) return [user];
    }
  }
  if (typeof title === "string" && title.trim()) {
    return [{ role: "assistant", content: title.trim() }];
  }
  return [];
}

/** Cap feed payload: keep chat chrome fields, drop bulky result row snapshots. */
function slimPreviewMessage(rec: Record<string, unknown>): Record<string, unknown> | null {
  const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
  if (!role) return null;
  const out: Record<string, unknown> = { role };
  if (typeof rec.content === "string" && rec.content) out.content = rec.content.slice(0, EXCERPT_MAX);
  if (typeof rec.reasoning === "string" && rec.reasoning.trim()) {
    out.reasoning = rec.reasoning.slice(0, EXCERPT_MAX);
  }
  if (typeof rec.sql === "string" && rec.sql.trim()) out.sql = rec.sql.slice(0, 20_000);
  if (typeof rec.ts === "number" && Number.isFinite(rec.ts)) out.ts = rec.ts;
  if (rec.chart && typeof rec.chart === "object" && !Array.isArray(rec.chart)) out.chart = rec.chart;
  // Omit result rows from the list payload — AssistantMessageBody re-runs SQL
  // when needed, same path as snapshot-less shares.
  if (!out.content && !out.sql && !out.reasoning && !out.chart) return null;
  return out;
}

export function flagsFromMessages(messages: unknown): { has_sql: boolean; has_chart: boolean } {
  const rows = Array.isArray(messages) ? messages : [];
  let has_sql = false;
  let has_chart = false;
  for (const row of rows) {
    const rec = messageRecord(row);
    if (!rec) continue;
    if (typeof rec.sql === "string" && rec.sql.trim()) has_sql = true;
    if (rec.chart && typeof rec.chart === "object" && !Array.isArray(rec.chart)) has_chart = true;
  }
  return { has_sql, has_chart };
}

export type TimelineQuery =
  | { ok: true; limit: number; before: number | null; handle: string | null }
  | { ok: false; status: 400; error: string };

export function parseTimelineQuery(q: URLSearchParams): TimelineQuery {
  const limitRaw = q.get("limit");
  let limit = LIST_DEFAULT;
  if (limitRaw != null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, status: 400, error: "limit must be a positive integer" };
    }
    limit = Math.min(n, LIST_MAX);
  }
  const beforeRaw = q.get("before");
  let before: number | null = null;
  if (beforeRaw != null && beforeRaw !== "") {
    const n = Number(beforeRaw);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, status: 400, error: "before must be a timestamp" };
    }
    before = n;
  }
  const handleRaw = q.get("handle");
  let handle: string | null = null;
  if (handleRaw != null && handleRaw !== "") {
    const parsed = parseHandle(handleRaw);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    handle = parsed.handle;
  }
  return { ok: true, limit, before, handle };
}

export async function recordShareOwner(db: D1Database, shareId: string, userId: string): Promise<void> {
  await db.prepare(
    `INSERT INTO share_owners (share_id, user_id, created_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(share_id) DO NOTHING`,
  ).bind(shareId, userId, Date.now()).run();
}

export async function getTimelineAuthor(
  db: D1Database,
  shareId: string,
): Promise<{ handle: string; name: string } | null> {
  return await db.prepare(
    `SELECT pr.handle AS handle, u.name AS name
     FROM timeline_posts p
     JOIN user_profiles pr ON pr.user_id = p.user_id
     JOIN "user" u ON u.id = p.user_id
     WHERE p.share_id = ?1`,
  ).bind(shareId).first<{ handle: string; name: string }>();
}

interface ShareRow {
  share_id: string;
  title: string | null;
  messages: string;
  expires_at: number | null;
}

interface TimelineRow {
  share_id: string;
  excerpt: string | null;
  has_sql: number;
  has_chart: number;
  published_at: number;
  title: string | null;
  model: string | null;
  messages: string | null;
  handle: string;
  name: string;
}

function itemFromRow(row: TimelineRow) {
  // Prefer a live first-message preview from the share so older posts stored
  // under the old 280-char cap still render expanded on the feed.
  let parsed: unknown = [];
  if (row.messages) {
    try {
      parsed = JSON.parse(row.messages);
    } catch {
      parsed = [];
    }
  }
  const messages = previewMessagesFromShare(parsed, row.title);
  let excerpt = row.excerpt ?? "";
  if (messages.length) {
    excerpt = excerptFromMessages(parsed, row.title) || excerpt;
  }
  return {
    share_id: row.share_id,
    url: "/share/" + row.share_id,
    title: row.title,
    excerpt,
    messages,
    handle: row.handle,
    name: row.name,
    published_at: row.published_at,
    model: row.model,
    has_sql: row.has_sql === 1,
    has_chart: row.has_chart === 1,
  };
}

async function listTimeline(env: TimelineEnv, req: Request): Promise<Response> {
  const parsed = parseTimelineQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status, "private");

  let profile: { handle: string; name: string } | null = null;
  if (parsed.handle) {
    profile = await env.SCHEMA_DB.prepare(
      `SELECT pr.handle AS handle, u.name AS name
       FROM user_profiles pr
       JOIN "user" u ON u.id = pr.user_id
       WHERE pr.handle = ?1`,
    ).bind(parsed.handle).first<{ handle: string; name: string }>();
    if (!profile) return json({ error: "not found" }, 404);
  }

  const clauses = ["(s.expires_at IS NULL OR s.expires_at > ?1)"];
  const bindings: (string | number)[] = [Date.now()];
  if (parsed.before != null) {
    bindings.push(parsed.before);
    clauses.push(`p.published_at < ?${bindings.length}`);
  }
  if (parsed.handle) {
    bindings.push(parsed.handle);
    clauses.push(`pr.handle = ?${bindings.length}`);
  }
  bindings.push(parsed.limit + 1);
  const sql =
    `SELECT p.share_id, p.excerpt, p.has_sql, p.has_chart, p.published_at,
            s.title, s.model, s.messages, pr.handle, u.name
     FROM timeline_posts p
     JOIN shared_chats s ON s.share_id = p.share_id
     JOIN user_profiles pr ON pr.user_id = p.user_id
     JOIN "user" u ON u.id = p.user_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY p.published_at DESC
     LIMIT ?${bindings.length}`;
  const rows = await env.SCHEMA_DB.prepare(sql).bind(...bindings).all<TimelineRow>();
  const list = rows.results ?? [];
  const extra = list.length > parsed.limit;
  const items = extra ? list.slice(0, parsed.limit) : list;
  const next_before = extra ? items[items.length - 1]?.published_at ?? null : null;
  return json({ items: items.map(itemFromRow), next_before, profile });
}

async function publishTimeline(env: TimelineEnv, req: Request): Promise<Response> {
  const user = await getSessionUser(env, req);
  if (!user) return json({ error: "unauthorized" }, 401, "private");
  const handle = await getHandle(env.SCHEMA_DB, user.id);
  if (!handle) return json({ error: "handle is required" }, 400, "private");

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON body" }, 400, "private");
  }
  const shareId = typeof body.share_id === "string" ? body.share_id.trim() : "";
  if (!SHARE_ID_RE.test(shareId)) return json({ error: "share_id is required" }, 400, "private");

  const share = await env.SCHEMA_DB.prepare(
    `SELECT share_id, title, messages, expires_at FROM shared_chats WHERE share_id = ?1`,
  ).bind(shareId).first<ShareRow>();
  if (!share || (share.expires_at && share.expires_at < Date.now())) {
    return json({ error: "not found" }, 404, "private");
  }

  const owner = await env.SCHEMA_DB.prepare(
    "SELECT user_id FROM share_owners WHERE share_id = ?1",
  ).bind(shareId).first<{ user_id: string }>();
  if (!owner) {
    return json({ error: "only the author can post this chat to the timeline" }, 403, "private");
  }
  if (owner.user_id !== user.id) {
    return json({ error: "forbidden" }, 403, "private");
  }

  const existing = await env.SCHEMA_DB.prepare(
    "SELECT published_at FROM timeline_posts WHERE share_id = ?1",
  ).bind(shareId).first<{ published_at: number }>();
  if (existing) {
    return json({ ok: true, share_id: shareId, published_at: existing.published_at }, 200, "private");
  }

  let messages: unknown = [];
  try {
    messages = JSON.parse(share.messages);
  } catch {
    messages = [];
  }
  const excerpt = excerptFromMessages(messages, share.title);
  const flags = flagsFromMessages(messages);
  const now = Date.now();
  try {
    await env.SCHEMA_DB.prepare(
      `INSERT INTO timeline_posts
         (share_id, user_id, excerpt, has_sql, has_chart, published_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(shareId, user.id, excerpt || null, flags.has_sql ? 1 : 0, flags.has_chart ? 1 : 0, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return json({ ok: true, share_id: shareId, published_at: now }, 200, "private");
    }
    console.error("timeline publish failed", error);
    return json({ error: "storage unavailable" }, 502, "private");
  }
  return json({ ok: true, share_id: shareId, published_at: now }, 200, "private");
}

async function unpublishTimeline(env: TimelineEnv, req: Request, shareId: string): Promise<Response> {
  const user = await getSessionUser(env, req);
  if (!user) return json({ error: "unauthorized" }, 401, "private");
  if (!SHARE_ID_RE.test(shareId)) return json({ error: "not found" }, 404, "private");

  const post = await env.SCHEMA_DB.prepare(
    "SELECT user_id FROM timeline_posts WHERE share_id = ?1",
  ).bind(shareId).first<{ user_id: string }>();
  if (post && post.user_id !== user.id) return json({ error: "forbidden" }, 403, "private");
  if (post) {
    await env.SCHEMA_DB.prepare(
      "DELETE FROM timeline_posts WHERE share_id = ?1 AND user_id = ?2",
    ).bind(shareId, user.id).run();
  }
  return json({ ok: true, share_id: shareId }, 200, "private");
}

export async function handleTimeline(env: TimelineEnv, req: Request, path: string): Promise<Response | null> {
  if (path === "/api/timeline") {
    if (req.method === "GET") return listTimeline(env, req);
    if (req.method === "POST") return publishTimeline(env, req);
    return json({ error: "method not allowed" }, 405, "private");
  }
  const item = path.match(/^\/api\/timeline\/([^/]+)$/);
  if (!item) return null;
  if (req.method === "DELETE") return unpublishTimeline(env, req, decodeURIComponent(item[1]));
  return json({ error: "method not allowed" }, 405, "private");
}
