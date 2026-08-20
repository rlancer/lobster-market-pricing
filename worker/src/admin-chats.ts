/**
 * Admin chat directory — lake chat_history rows enriched with Better Auth
 * profiles when a user_id is present, otherwise a stable visitor fingerprint
 * derived from the server-stamped IP + User-Agent (no client fingerprinting).
 */
import { avatarUrlFor } from "./avatars";
import { isAdminEmail } from "./admin";
import { publicName } from "./profiles";

export interface AdminChatUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  handle: string | null;
  display_name: string | null;
  public_name: string;
  avatar_url: string | null;
  is_admin: boolean;
}

export interface AdminChatHistoryRow {
  chat_id: string;
  mode: string;
  model: string | null;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  started_at: string;
  ended_at: string;
  source: string;
  fetched_at: string;
  messages: unknown;
}

export interface AdminChatItem extends AdminChatHistoryRow {
  title: string | null;
  message_count: number;
  /** Stable short id from IP + UA for anonymous visitors; null when signed in. */
  visitor_fingerprint: string | null;
  /** Truncated UA for the admin table (browser / OS hint). */
  user_agent_summary: string | null;
  user: AdminChatUser | null;
}

type ProfileJoinRow = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_key: string | null;
  profile_updated_at: number | null;
};

/** FNV-1a 32-bit → 8 hex chars. Stable visitor hint from IP + UA only. */
export function visitorFingerprint(ip: string | null, ua: string | null): string | null {
  const seed = [ip?.trim() || "", ua?.trim() || ""].join("|");
  if (!seed || seed === "|") return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Compact browser/OS line for the admin table — never the full UA blob. */
export function summarizeUserAgent(ua: string | null | undefined): string | null {
  const raw = ua?.trim();
  if (!raw) return null;
  const browser =
    /\bEdg\/[\d.]+/i.test(raw) ? "Edge"
    : /\bOPR\/[\d.]+|\bOpera\//i.test(raw) ? "Opera"
    : /\bChrome\/[\d.]+/i.test(raw) && !/\bChromium\//i.test(raw) ? "Chrome"
    : /\bFirefox\/[\d.]+/i.test(raw) ? "Firefox"
    : /\bSafari\/[\d.]+/i.test(raw) && !/\bChrome\//i.test(raw) ? "Safari"
    : /\bMSIE\b|\bTrident\//i.test(raw) ? "IE"
    : null;
  const os =
    /\bWindows NT\b/i.test(raw) ? "Windows"
    : /\bAndroid\b/i.test(raw) ? "Android"
    : /\biPhone\b|\biPad\b|\biPod\b/i.test(raw) ? "iOS"
    : /\bMac OS X\b|\bMacintosh\b/i.test(raw) ? "macOS"
    : /\bLinux\b/i.test(raw) ? "Linux"
    : null;
  if (browser && os) return `${browser} · ${os}`;
  if (browser) return browser;
  if (os) return os;
  return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
}

function asMessageList(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m): m is Record<string, unknown> =>
    Boolean(m) && typeof m === "object" && !Array.isArray(m),
  );
}

/** First user turn, clipped — used as the row title in the admin table. */
export function chatTitleFromMessages(messages: unknown, max = 96): string | null {
  for (const msg of asMessageList(messages)) {
    if (String(msg.role ?? "") !== "user") continue;
    const content = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!content) continue;
    const oneLine = content.replace(/\s+/g, " ");
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
  }
  return null;
}

export function messageCount(messages: unknown): number {
  return asMessageList(messages).length;
}

export function rowToAdminChatUser(row: ProfileJoinRow): AdminChatUser {
  const display_name = row.display_name?.trim() || null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image ?? null,
    handle: row.handle ?? null,
    display_name,
    public_name: publicName(display_name, row.name),
    avatar_url: avatarUrlFor(row.id, row.avatar_key, row.profile_updated_at),
    is_admin: isAdminEmail(row.email),
  };
}

/** Batch-load profiles for the distinct user_ids on a page of lake rows. */
export async function loadAdminChatUsers(
  db: D1Database,
  userIds: string[],
): Promise<Map<string, AdminChatUser>> {
  const unique = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))];
  const out = new Map<string, AdminChatUser>();
  if (unique.length === 0) return out;

  // D1 has no array bind; chunk IN lists. 50 keeps the SQL short.
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(", ");
    const result = await db
      .prepare(
        `SELECT
           u.id AS id,
           u.email AS email,
           u.name AS name,
           u.image AS image,
           p.handle AS handle,
           p.display_name AS display_name,
           p.avatar_key AS avatar_key,
           p.updated_at AS profile_updated_at
         FROM "user" u
         LEFT JOIN user_profiles p ON p.user_id = u.id
         WHERE u.id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<ProfileJoinRow>();
    for (const row of result.results ?? []) {
      out.set(row.id, rowToAdminChatUser(row));
    }
  }
  return out;
}

export function enrichAdminChatItem(
  row: AdminChatHistoryRow,
  users: Map<string, AdminChatUser>,
): AdminChatItem {
  const user = row.user_id ? users.get(row.user_id) ?? null : null;
  return {
    ...row,
    title: chatTitleFromMessages(row.messages),
    message_count: messageCount(row.messages),
    visitor_fingerprint: user ? null : visitorFingerprint(row.ip, row.user_agent),
    user_agent_summary: summarizeUserAgent(row.user_agent),
    user,
  };
}

export async function enrichAdminChatItems(
  db: D1Database,
  rows: AdminChatHistoryRow[],
): Promise<AdminChatItem[]> {
  const users = await loadAdminChatUsers(
    db,
    rows.map((r) => r.user_id).filter((id): id is string => Boolean(id)),
  );
  return rows.map((row) => enrichAdminChatItem(row, users));
}
