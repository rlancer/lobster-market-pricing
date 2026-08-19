/**
 * Custom user avatars — Cloudflare Images (hosted), keyed on user_profiles.
 *
 * Upload via env.IMAGES.hosted; the Images id is stored in
 * user_profiles.avatar_key. Public GET /api/avatars/{userId} streams the
 * original bytes through the binding (stable app URL, CDN-friendly headers).
 *
 * SVG is allowed; Cloudflare sanitizes hosted SVGs, and we still reject
 * obvious script/handler payloads before upload.
 */
import type { SessionUser } from "./auth";

/** Cloudflare Images allows up to 10 MB; keep headroom under that. */
export const AVATAR_MAX_BYTES = 5_242_880; // 5 MiB
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
  IMAGES: ImagesBinding;
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

function filenameForMime(mime: string): string {
  if (mime === "image/svg+xml") return "avatar.svg";
  if (mime === "image/png") return "avatar.png";
  if (mime === "image/webp") return "avatar.webp";
  return "avatar.jpg";
}

/**
 * Replace the caller's avatar. Requires an existing user_profiles row (handle
 * claimed). Uploads to Cloudflare Images and stores the image id in avatar_key.
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
    return { ok: false, status: 413, error: "avatar must be 5 MB or smaller" };
  }
  if (mime === "image/svg+xml") {
    const safe = assertSafeSvg(bytes);
    if (!safe.ok) return { ok: false, status: 400, error: safe.error };
  }

  const profile = await env.SCHEMA_DB.prepare(
    "SELECT handle, avatar_key FROM user_profiles WHERE user_id = ?1",
  ).bind(user.id).first<{ handle: string; avatar_key: string | null }>();
  if (!profile) {
    return { ok: false, status: 400, error: "claim a handle before uploading an avatar" };
  }

  let uploaded: ImageMetadata;
  try {
    uploaded = await env.IMAGES.hosted.upload(bytes, {
      filename: filenameForMime(mime),
      metadata: { user_id: user.id, purpose: "avatar", content_type: mime },
      creator: user.id,
      requireSignedURLs: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, error: `image upload failed: ${message.slice(0, 200)}` };
  }

  const now = Date.now();
  await env.SCHEMA_DB.prepare(
    `UPDATE user_profiles SET avatar_key = ?1, updated_at = ?2 WHERE user_id = ?3`,
  ).bind(uploaded.id, now, user.id).run();

  if (profile.avatar_key && profile.avatar_key !== uploaded.id) {
    try {
      await env.IMAGES.hosted.image(profile.avatar_key).delete();
    } catch {
      /* best-effort cleanup of the previous Images object */
    }
  }

  return { ok: true, avatar_url: avatarUrlFor(user.id, uploaded.id, now) };
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
      await env.IMAGES.hosted.image(profile.avatar_key).delete();
    } catch {
      /* best-effort */
    }
  }
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
    "SELECT avatar_key, updated_at FROM user_profiles WHERE user_id = ?1",
  ).bind(id).first<{ avatar_key: string | null; updated_at: number }>();
  if (!row?.avatar_key) return new Response("not found", { status: 404 });

  const handle = env.IMAGES.hosted.image(row.avatar_key);

  let details: ImageMetadata | null = null;
  try {
    details = await handle.details();
  } catch {
    details = null;
  }

  // Prefer the Images CDN variant — correct Content-Type, no Worker stream
  // footguns. <img src="/api/avatars/..."> follows the redirect fine.
  const variant = details?.variants?.find((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  if (variant) {
    return Response.redirect(variant, 302);
  }

  let bytes: ReadableStream<Uint8Array> | null = null;
  try {
    bytes = await handle.bytes();
  } catch {
    bytes = null;
  }
  if (!bytes) return new Response("not found", { status: 404 });

  // Buffer the payload (avatars are ≤5 MB, usually ≪512 KB after client resize).
  // Avoid stream.tee()+cancel — that was returning an empty/corrupt body that
  // painted as a broken <img> after the optimistic local preview.
  const buffer = await new Response(bytes).arrayBuffer();
  if (buffer.byteLength === 0) return new Response("not found", { status: 404 });

  const contentType =
    contentTypeFromFilename(details?.filename)
    ?? metaContentType(details?.meta)
    ?? sniffImageContentType(new Uint8Array(buffer.slice(0, 256)))
    ?? "image/jpeg";

  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    ETag: `"${row.updated_at}"`,
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType === "image/svg+xml") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    );
  }
  return new Response(buffer, { status: 200, headers });
}

function contentTypeFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const name = filename.toLowerCase();
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  return null;
}

function metaContentType(meta: Record<string, unknown> | null | undefined): string | null {
  const raw = meta?.content_type;
  if (typeof raw !== "string") return null;
  const mime = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return AVATAR_MIME.has(mime) ? mime : null;
}

/** Peek at magic bytes so <img> never gets application/octet-stream. */
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
