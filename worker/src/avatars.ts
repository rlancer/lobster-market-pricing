/**
 * Custom user avatars — D1 BLOBs keyed off user_id.
 *
 * Public GET /api/avatars/{userId} serves the bytes. Upload/delete require a
 * session and a claimed handle (FK → user_profiles). Stored in D1 (not R2)
 * so Worker deploy stays within the existing CI API-token permissions.
 */
import type { SessionUser } from "./auth";

export const AVATAR_MAX_BYTES = 1_048_576; // 1 MiB
export const AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

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
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!AVATAR_MIME.has(mime)) {
    return { ok: false, status: 415, error: "avatar must be a JPEG, PNG, or WebP image" };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, error: "avatar file is empty" };
  }
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return { ok: false, status: 413, error: "avatar must be 1 MB or smaller" };
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
  const headers = new Headers({
    "Content-Type": row.content_type || "image/jpeg",
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    ETag: `"${row.updated_at}"`,
  });
  return new Response(row.data, { status: 200, headers });
}
