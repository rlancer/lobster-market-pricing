/**
 * Custom user avatars — D1 BLOBs keyed off user_id.
 *
 * Public GET /api/avatars/{userId} serves the bytes. Upload/delete require a
 * session and a claimed handle.
 *
 * D1 quirk (Workers binding): BLOB columns are returned as a plain number[]
 * (Array.from on the bytes), not ArrayBuffer. We coerce on read and bind
 * Uint8Array on write so <img> gets a real binary body.
 */
import type { SessionUser } from "./auth";

/** Keep headroom under D1 practical row limits; client already ≤512px JPEG. */
export const AVATAR_MAX_BYTES = 2_097_152; // 2 MiB
export const AVATAR_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

/** Sentinel stored on user_profiles.avatar_key when a D1 blob exists. */
export const AVATAR_D1_KEY = "d1";

const SVG_DANGEROUS =
  /<script[\s>/]|on[a-z]+\s*=|javascript:|data:\s*text\/html|<foreignObject/i;

export interface AvatarEnv {
  SCHEMA_DB: D1Database;
}

export type AvatarResult =
  | { ok: true; avatar_url: string | null }
  | { ok: false; status: 400 | 404 | 413 | 415 | 502; error: string };

export function avatarUrlFor(
  userId: string,
  imageId: string | null | undefined,
  version?: number | null,
): string | null {
  if (!imageId) return null;
  const base = `/api/avatars/${encodeURIComponent(userId)}`;
  return typeof version === "number" && version > 0 ? `${base}?v=${version}` : base;
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
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
    .decode(bytes.slice(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/** Peek at magic bytes so we never store/serve the wrong Content-Type. */
export function sniffImageContentType(header: Uint8Array): string | null {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    header.length >= 8
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    header.length >= 12
    && header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
    && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  ) {
    return "image/webp";
  }
  if (header.length >= 6 && header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
    return "image/gif";
  }
  const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(header.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/**
 * D1 returns BLOB as number[] (see Workers D1 type conversion). Also accept
 * ArrayBuffer / TypedArray from tests or future runtime changes.
 */
export function d1BlobToUint8Array(data: unknown): Uint8Array | null {
  if (data == null) return null;
  if (data instanceof ArrayBuffer) {
    return data.byteLength > 0 ? new Uint8Array(data) : null;
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return view.byteLength > 0
      ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      : null;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    return new Uint8Array(data as number[]);
  }
  return null;
}

/**
 * Replace the caller's avatar. Requires an existing user_profiles row (handle
 * claimed). Writes bytes to D1 and marks avatar_key so public profiles expose
 * `/api/avatars/{user_id}`.
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
    return { ok: false, status: 413, error: "avatar must be 2 MB or smaller" };
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
  const payload = new Uint8Array(bytes);
  try {
    const write = await env.SCHEMA_DB.prepare(
      `INSERT INTO user_avatars (user_id, content_type, data, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(user_id) DO UPDATE SET
         content_type = excluded.content_type,
         data = excluded.data,
         updated_at = excluded.updated_at`,
    ).bind(user.id, mime, payload, now).run();
    if (!write.success) {
      return { ok: false, status: 502, error: "avatar store failed" };
    }

    // Confirm the blob actually landed — D1 can report success while leaving
    // an unreadable/empty BLOB, which previously made GET /api/avatars 404
    // after a "successful" upload.
    const stored = await env.SCHEMA_DB.prepare(
      `SELECT length(data) AS nbytes FROM user_avatars WHERE user_id = ?1`,
    ).bind(user.id).first<{ nbytes: number | null }>();
    if (!stored || !stored.nbytes || stored.nbytes < 32) {
      return { ok: false, status: 502, error: "avatar store wrote an empty blob" };
    }

    await env.SCHEMA_DB.prepare(
      `UPDATE user_profiles SET avatar_key = ?1, updated_at = ?2 WHERE user_id = ?3`,
    ).bind(AVATAR_D1_KEY, now, user.id).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, error: `avatar store failed: ${message.slice(0, 200)}` };
  }

  return { ok: true, avatar_url: avatarUrlFor(user.id, AVATAR_D1_KEY, now) };
}

export async function clearAvatar(env: AvatarEnv, user: SessionUser): Promise<AvatarResult> {
  const profile = await env.SCHEMA_DB.prepare(
    "SELECT handle FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ handle: string }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before clearing an avatar" };
  }
  await env.SCHEMA_DB.prepare("DELETE FROM user_avatars WHERE user_id = ?1").bind(user.id).run();
  await env.SCHEMA_DB.prepare(
    `UPDATE user_profiles SET avatar_key = NULL, updated_at = ?1 WHERE user_id = ?2`,
  ).bind(Date.now(), user.id).run();
  return { ok: true, avatar_url: null };
}

export async function serveAvatar(env: AvatarEnv, userId: string): Promise<Response> {
  const id = userId.trim();
  if (!id || id.length > 128 || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const row = await env.SCHEMA_DB.prepare(
    "SELECT content_type, data, updated_at FROM user_avatars WHERE user_id = ?1",
  ).bind(id).first<{ content_type: string; data: unknown; updated_at: number }>();

  const bytes = d1BlobToUint8Array(row?.data);
  if (!bytes) {
    return new Response("not found", { status: 404 });
  }

  const contentType =
    (row?.content_type && AVATAR_MIME.has(row.content_type) ? row.content_type : null)
    ?? sniffImageContentType(bytes.subarray(0, 256))
    ?? "image/jpeg";

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    ETag: `"${row?.updated_at ?? 0}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType === "image/svg+xml") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
  }
  // Copy into a fresh ArrayBuffer-backed view — Response rejects plain number[].
  return new Response(bytes, { status: 200, headers });
}
