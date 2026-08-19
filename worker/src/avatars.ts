/**
 * Custom user avatars — D1 BLOBs keyed off user_id.
 *
 * Public GET /api/avatars/{userId} serves the bytes. Upload/delete require a
 * session and a claimed handle (FK → user_profiles). Stored in D1 (not R2)
 * so Worker deploy stays within the existing CI API-token permissions.
 *
 * SVG is allowed as image/svg+xml. Bytes are screened for script / event-handler
 * payloads; responses use nosniff + a tight CSP. The UI only renders avatars
 * inside <img>, which does not execute SVG script.
 */
import type { SessionUser } from "./auth";

export const AVATAR_MAX_BYTES = 1_048_576; // 1 MiB
export const AVATAR_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

const SVG_DANGEROUS =
  /<script[\s>/]|on[a-z]+\s*=|javascript:|data:\s*text\/html|<foreignObject/i;

export interface AvatarEnv {
  SCHEMA_DB: D1Database;
}

export type AvatarResult =
  | { ok: true; avatar_url: string | null }
  | { ok: false; status: 400 | 404 | 413 | 415; error: string };

export function avatarUrlFor(
  userId: string,
  hasAvatar: boolean,
  version?: number | null,
): string | null {
  if (!hasAvatar) return null;
  const base = `/api/avatars/${encodeURIComponent(userId)}`;
  return typeof version === "number" && version > 0 ? `${base}?v=${version}` : base;
}

export async function hasAvatar(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 AS n FROM user_avatars WHERE user_id = ?1",
  ).bind(userId).first();
  return Boolean(row);
}

/** Reject SVG that is not markup or that carries script/handler payloads. */
export function assertSafeSvg(bytes: ArrayBuffer): { ok: true } | { ok: false; error: string } {
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
  const head = text.trimStart().slice(0, 256).toLowerCase();
  if (!head.startsWith("<svg") && !head.startsWith("<?xml")) {
    return { ok: false, error: "file is not a valid SVG" };
  }
  if (!/<svg[\s>]/i.test(text)) {
    return { ok: false, error: "file is not a valid SVG" };
  }
  if (SVG_DANGEROUS.test(text)) {
    return { ok: false, error: "SVG contains disallowed content" };
  }
  return { ok: true };
}

/** Prefer declared MIME; sniff SVG from body when the client omits/mislabels type. */
export function resolveAvatarMime(contentType: string, bytes: ArrayBuffer): string | null {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (AVATAR_MIME.has(mime)) return mime;
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/**
 * Replace the caller's avatar. Requires an existing user_profiles row (handle
 * claimed).
 */
export async function putAvatar(
  env: AvatarEnv,
  user: SessionUser,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<AvatarResult> {
  const mime = resolveAvatarMime(contentType, bytes);
  if (!mime) {
    return { ok: false, status: 415, error: "avatar must be a JPEG, PNG, WebP, or SVG image" };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, error: "avatar file is empty" };
  }
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return { ok: false, status: 413, error: "avatar must be 1 MB or smaller" };
  }
  if (mime === "image/svg+xml") {
    const safe = assertSafeSvg(bytes);
    if (!safe.ok) return { ok: false, status: 400, error: safe.error };
  }

  const profile = await env.SCHEMA_DB.prepare(
    "SELECT handle FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ handle: string }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before uploading an avatar" };
  }

  const now = Date.now();
  // D1 bind accepts ArrayBuffer / Uint8Array for BLOB columns.
  await env.SCHEMA_DB.prepare(
    `INSERT INTO user_avatars (user_id, content_type, data, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       content_type = excluded.content_type,
       data = excluded.data,
       updated_at = excluded.updated_at`,
  ).bind(user.id, mime, bytes, now).run();

  return { ok: true, avatar_url: avatarUrlFor(user.id, true, now) };
}

export async function clearAvatar(env: AvatarEnv, user: SessionUser): Promise<AvatarResult> {
  const profile = await env.SCHEMA_DB.prepare(
    "SELECT handle FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ handle: string }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before clearing an avatar" };
  }
  await env.SCHEMA_DB.prepare(
    "DELETE FROM user_avatars WHERE user_id = ?1",
  ).bind(user.id).run();
  return { ok: true, avatar_url: null };
}

export async function serveAvatar(env: AvatarEnv, userId: string): Promise<Response> {
  const id = userId.trim();
  if (!id || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const row = await env.SCHEMA_DB.prepare(
    "SELECT content_type, data, updated_at FROM user_avatars WHERE user_id = ?1",
  ).bind(id).first<{ content_type: string; data: ArrayBuffer; updated_at: number }>();
  if (!row?.data) return new Response("not found", { status: 404 });
  const contentType = row.content_type || "image/jpeg";
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    ETag: `"${row.updated_at}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType === "image/svg+xml") {
    // Defense in depth if the URL is opened as a document instead of <img>.
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
  }
  return new Response(row.data, { status: 200, headers });
}
