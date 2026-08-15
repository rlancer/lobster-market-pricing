/**
 * Public handles on SCHEMA_DB (user_profiles).
 *
 * Google identity stays in Better Auth's "user" row. Handle is the product
 * slug — unique, lowercase, letters+digits — claimed on first login and
 * editable later. Chat ownership still keys off user_id; handle is only for
 * the public surface (timeline /u/{handle} later).
 */
const HANDLE_MIN = 3;
const HANDLE_MAX = 24;
const HANDLE_RE = /^[a-z][a-z0-9]{2,23}$/;

/** Path segments and product words that must never become a public slug. */
const RESERVED_HANDLES = new Set([
  "about",
  "account",
  "accounts",
  "admin",
  "api",
  "assets",
  "auth",
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

/**
 * Claim or rename. Same-user upsert on user_id; a UNIQUE hit on handle means
 * someone else already has it (SQLite aborts the whole statement).
 */
export async function setHandle(db: D1Database, userId: string, value: unknown): Promise<HandleResult> {
  const parsed = parseHandle(value);
  if (!parsed.ok) return parsed;
  const existing = await getHandle(db, userId);
  if (existing === parsed.handle) return parsed;
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
