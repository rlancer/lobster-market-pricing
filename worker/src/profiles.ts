/**
 * Public handles on SCHEMA_DB (user_profiles).
 *
 * Google identity stays in Better Auth's "user" row. Handle is the product
 * slug — unique, lowercase, letters+digits — claimed on first login and
 * editable later. Display name + custom avatar live on the same row so the
 * public surface is editable without mutating the auth identity. Chat
 * ownership still keys off user_id; handle is only for the public surface
 * (timeline /u/{handle}).
 */
import { avatarUrlFor } from "./avatars";

const HANDLE_MIN = 3;
const HANDLE_MAX = 24;
const HANDLE_RE = /^[a-z][a-z0-9]{2,23}$/;

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 80;

/** Path segments and product words that must never become a public slug. */
const RESERVED_HANDLES = new Set([
  "about",
  "account",
  "accounts",
  "admin",
  "api",
  "assets",
  "auth",
  "avatar",
  "avatars",
  "bot",
  "bots",
  "brand",
  "chat",
  "chats",
  "comment",
  "comments",
  "copilot",
  "data",
  "docs",
  "feed",
  "fork",
  "help",
  "lab",
  "lobster",
  "login",
  "logout",
  "me",
  "monitor",
  "new",
  "null",
  "profile",
  "profiles",
  "research",
  "settings",
  "share",
  "signup",
  "static",
  "support",
  "symbol",
  "timeline",
  "u",
  "undefined",
  "user",
  "users",
  "www",
]);

export type HandleOk = { ok: true; handle: string };
export type HandleErr = { ok: false; status: 400 | 409; error: string };
export type HandleResult = HandleOk | HandleErr;

export type DisplayNameOk = { ok: true; display_name: string | null };
export type DisplayNameErr = { ok: false; status: 400; error: string };
export type DisplayNameResult = DisplayNameOk | DisplayNameErr;

export interface UserProfileRow {
  handle: string;
  display_name: string | null;
  avatar_key: string | null;
  created_at: number;
  updated_at: number;
}

export function parseHandle(value: unknown): HandleResult {
  if (typeof value !== "string") return { ok: false, status: 400, error: "handle is required" };
  const handle = value.trim().toLowerCase();
  if (!handle) return { ok: false, status: 400, error: "handle is required" };
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return { ok: false, status: 400, error: `handle must be ${HANDLE_MIN}–${HANDLE_MAX} characters` };
  }
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      status: 400,
      error: "handle must start with a letter and use only lowercase letters and numbers",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { ok: false, status: 400, error: "that handle is reserved" };
  }
  return { ok: true, handle };
}

/**
 * Empty / whitespace-only clears the product display name (public UI falls
 * back to the Google OAuth name). Non-empty values are trimmed and capped.
 */
export function parseDisplayName(value: unknown): DisplayNameResult {
  if (value == null) return { ok: true, display_name: null };
  if (typeof value !== "string") {
    return { ok: false, status: 400, error: "display_name must be a string" };
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: true, display_name: null };
  if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
    return {
      ok: false,
      status: 400,
      error: `display_name must be ${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters`,
    };
  }
  return { ok: true, display_name: trimmed };
}

function slugCandidate(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^[^a-z]+/, "").slice(0, HANDLE_MAX);
}

/** Prefill for first-login — never auto-claimed. Reserved / invalid slugs are skipped. */
export function suggestHandle(email?: string | null, name?: string | null): string | null {
  const candidates: string[] = [];
  const local = email?.split("@")[0];
  if (local) candidates.push(local);
  if (name) candidates.push(name);
  for (const raw of candidates) {
    const parsed = parseHandle(slugCandidate(raw));
    if (parsed.ok) return parsed.handle;
  }
  return null;
}

export async function getHandle(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT handle FROM user_profiles WHERE user_id = ?1",
  ).bind(userId).first<{ handle: string }>();
  return row?.handle ?? null;
}

export async function getUserProfile(db: D1Database, userId: string): Promise<UserProfileRow | null> {
  return db.prepare(
    `SELECT handle, display_name, avatar_key, created_at, updated_at
     FROM user_profiles WHERE user_id = ?1`,
  ).bind(userId).first<UserProfileRow>();
}

/** Public display name: product override, else Google OAuth name. */
export function publicName(displayName: string | null | undefined, oauthName: string | null | undefined): string {
  const custom = displayName?.trim();
  if (custom) return custom;
  return (oauthName ?? "").trim() || "Member";
}

export function profilePublicFields(
  userId: string,
  row: Pick<UserProfileRow, "display_name" | "avatar_key"> | null,
  oauthName: string | null | undefined,
): { display_name: string | null; name: string; avatar_url: string | null } {
  const display_name = row?.display_name?.trim() || null;
  return {
    display_name,
    name: publicName(display_name, oauthName),
    avatar_url: avatarUrlFor(userId, row?.avatar_key),
  };
}

/**
 * Claim or rename. Same-user upsert on user_id; a UNIQUE hit on handle means
 * someone else already has it (SQLite aborts the whole statement).
 */
export async function setHandle(db: D1Database, userId: string, value: unknown): Promise<HandleResult> {
  const parsed = parseHandle(value);
  if (!parsed.ok) return parsed;
  const existing = await getHandle(db, userId);
  if (existing === parsed.handle) return parsed;
  // Bot profiles share the /u/{handle} namespace — reject human claims that collide.
  const bot = await db.prepare("SELECT 1 AS n FROM bot_profiles WHERE handle = ?1").bind(parsed.handle).first();
  if (bot) return { ok: false, status: 409, error: "that handle is taken" };
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO user_profiles (user_id, handle, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(user_id) DO UPDATE SET
         handle = excluded.handle,
         updated_at = excluded.updated_at`,
    ).bind(userId, parsed.handle, now).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return { ok: false, status: 409, error: "that handle is taken" };
    }
    throw error;
  }
  return parsed;
}

export type ProfileUpdateOk = {
  ok: true;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  name: string;
};
export type ProfileUpdateErr = { ok: false; status: 400 | 409; error: string };
export type ProfileUpdateResult = ProfileUpdateOk | ProfileUpdateErr;

/**
 * Patch handle and/or display_name. Handle claim creates the row; display_name
 * alone requires an existing profile.
 */
export async function updateProfile(
  db: D1Database,
  userId: string,
  body: { handle?: unknown; display_name?: unknown },
  oauthName: string | null | undefined,
): Promise<ProfileUpdateResult> {
  const hasHandle = Object.prototype.hasOwnProperty.call(body, "handle");
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "display_name");
  if (!hasHandle && !hasDisplayName) {
    return { ok: false, status: 400, error: "handle or display_name is required" };
  }

  if (hasHandle) {
    const handleResult = await setHandle(db, userId, body.handle);
    if (!handleResult.ok) return handleResult;
  }

  let displayNameValue: string | null | undefined;
  if (hasDisplayName) {
    const parsed = parseDisplayName(body.display_name);
    if (!parsed.ok) return parsed;
    displayNameValue = parsed.display_name;
    const existing = await getUserProfile(db, userId);
    if (!existing) {
      return { ok: false, status: 400, error: "claim a handle before setting a display name" };
    }
    await db.prepare(
      `UPDATE user_profiles SET display_name = ?1, updated_at = ?2 WHERE user_id = ?3`,
    ).bind(displayNameValue, Date.now(), userId).run();
  }

  const row = await getUserProfile(db, userId);
  if (!row) {
    return { ok: false, status: 400, error: "claim a handle before updating your profile" };
  }
  const pub = profilePublicFields(userId, row, oauthName);
  return {
    ok: true,
    handle: row.handle,
    display_name: pub.display_name,
    avatar_url: pub.avatar_url,
    name: pub.name,
  };
}
