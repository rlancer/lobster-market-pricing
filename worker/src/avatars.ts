/**
 * Custom user avatars — R2 objects keyed off user_id, metadata on user_profiles.
 *
 * Public GET /api/avatars/{userId} serves the object. Upload/delete require a
 * session and a claimed handle (avatar_key lives on user_profiles).
 */
import type { SessionUser } from "./auth";

export const AVATAR_MAX_BYTES = 1_048_576; // 1 MiB
export const AVATAR_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface AvatarEnv {
  SCHEMA_DB: D1Database;
  AVATARS: R2Bucket;
}

export type AvatarResult =
  | { ok: true; avatar_url: string | null; avatar_key: string | null }
  | { ok: false; status: 400 | 404 | 413 | 415; error: string };

export function avatarUrlFor(userId: string, avatarKey: string | null | undefined): string | null {
  if (!avatarKey) return null;
  return `/api/avatars/${encodeURIComponent(userId)}`;
}

export function avatarObjectKey(userId: string, ext: string): string {
  return `avatars/${userId}.${ext}`;
}

function extForMime(mime: string): string | null {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return null;
}

export async function getAvatarKey(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT avatar_key FROM user_profiles WHERE user_id = ?1",
  ).bind(userId).first<{ avatar_key: string | null }>();
  return row?.avatar_key ?? null;
}

/**
 * Replace the caller's avatar. Requires an existing user_profiles row (handle
 * claimed). Deletes the previous R2 object when the key changes.
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
  const ext = extForMime(mime);
  if (!ext) return { ok: false, status: 415, error: "avatar must be a JPEG, PNG, or WebP image" };
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, error: "avatar file is empty" };
  }
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    return { ok: false, status: 413, error: "avatar must be 1 MB or smaller" };
  }

  const profile = await env.SCHEMA_DB.prepare(
    "SELECT handle, avatar_key FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ handle: string; avatar_key: string | null }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before uploading an avatar" };
  }

  const key = avatarObjectKey(user.id, ext);
  await env.AVATARS.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { user_id: user.id },
  });

  const now = Date.now();
  await env.SCHEMA_DB.prepare(
    `UPDATE user_profiles SET avatar_key = ?1, updated_at = ?2 WHERE user_id = ?3`,
  ).bind(key, now, user.id).run();

  if (profile.avatar_key && profile.avatar_key !== key) {
    try {
      await env.AVATARS.delete(profile.avatar_key);
    } catch {
      /* best-effort cleanup */
    }
  }

  return { ok: true, avatar_key: key, avatar_url: avatarUrlFor(user.id, key) };
}

export async function clearAvatar(env: AvatarEnv, user: SessionUser): Promise<AvatarResult> {
  const profile = await env.SCHEMA_DB.prepare(
    "SELECT avatar_key FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ avatar_key: string | null }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before clearing an avatar" };
  }
  if (profile.avatar_key) {
    try {
      await env.AVATARS.delete(profile.avatar_key);
    } catch {
      /* best-effort */
    }
  }
  await env.SCHEMA_DB.prepare(
    `UPDATE user_profiles SET avatar_key = NULL, updated_at = ?1 WHERE user_id = ?2`,
  ).bind(Date.now(), user.id).run();
  return { ok: true, avatar_key: null, avatar_url: null };
}

export async function serveAvatar(env: AvatarEnv, userId: string): Promise<Response> {
  const id = userId.trim();
  if (!id || id.length > 128 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return new Response("not found", { status: 404 });
  }
  const key = await getAvatarKey(env.SCHEMA_DB, id);
  if (!key) return new Response("not found", { status: 404 });
  const obj = await env.AVATARS.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
  return new Response(obj.body, { status: 200, headers });
}
