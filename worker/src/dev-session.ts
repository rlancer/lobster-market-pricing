/**
 * Dev-only impersonation so agents can exercise signed-in surfaces
 * (personal bots, Chat restore, Schwab) as an admin account.
 *
 * Production (`api.lobster.mp`) never enables this. Preview requires both
 * `ALLOW_DEV_IMPERSONATION=1` (wrangler env.dev vars) and `ADMIN_TOKEN`.
 * Only emails on the product admin allowlist can be assumed.
 */
import { getCookies } from "better-auth/cookies";
import { isAdminEmail } from "./admin";
import {
  createAuth,
  findUserByEmail,
  impersonationAllowed,
  parseDevAsEmail,
  type AuthEnv,
  type SessionUser,
} from "./auth";

export const DEV_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const DEV_SESSION_IP = "dev-impersonation";
export const DEV_SESSION_UA = "admin-dev-session";

export interface DevSessionCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string;
  secure: boolean;
  http_only: boolean;
  same_site: string;
  max_age: number;
  header: string;
}

export interface MintDevSessionResult {
  ok: true;
  user: SessionUser;
  expires_at: number;
  cookie: DevSessionCookie;
}

function serializeCookie(
  name: string,
  value: string,
  attrs: { domain?: string; path: string; maxAge: number; httpOnly: boolean; secure: boolean; sameSite: string },
): string {
  const parts = [`${name}=${value}`, `Path=${attrs.path}`, `Max-Age=${attrs.maxAge}`];
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  const sameSite = attrs.sameSite[0]?.toUpperCase() + attrs.sameSite.slice(1);
  parts.push(`SameSite=${sameSite}`);
  return parts.join("; ");
}

/** Same contract as better-call `signCookieValue` — HMAC-SHA256, then encodeURIComponent. */
async function signCookieValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const bytes = new Uint8Array(signature);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return encodeURIComponent(`${value}.${btoa(bin)}`);
}

export function resolveImpersonationEmail(bodyEmail: unknown, fallbackAdminEmail: string): string | null {
  if (typeof bodyEmail === "string" && bodyEmail.trim()) return parseDevAsEmail(bodyEmail);
  return parseDevAsEmail(fallbackAdminEmail);
}

export async function mintDevSession(
  env: AuthEnv,
  req: Request,
  email: string,
): Promise<
  | MintDevSessionResult
  | { ok: false; status: number; error: string }
> {
  if (!impersonationAllowed(env, new URL(req.url).hostname)) {
    return { ok: false, status: 404, error: "not found" };
  }
  const target = parseDevAsEmail(email);
  if (!target || !isAdminEmail(target)) {
    return { ok: false, status: 403, error: "email is not impersonable" };
  }
  const user = await findUserByEmail(env.SCHEMA_DB, target);
  if (!user) return { ok: false, status: 404, error: "user has never signed in" };

  const auth = createAuth(env, req);
  if (!auth) return { ok: false, status: 503, error: "auth is not configured" };
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return { ok: false, status: 503, error: "auth is not configured" };

  const context = await auth.$context;
  const expiresAt = new Date(Date.now() + DEV_SESSION_TTL_MS);
  const session = await context.internalAdapter.createSession(user.id, false, {
    expiresAt,
    ipAddress: DEV_SESSION_IP,
    userAgent: DEV_SESSION_UA,
  });
  const cookies = getCookies(auth.options);
  const signed = await signCookieValue(session.token, secret);
  const attrs = cookies.sessionToken.attributes;
  const maxAge = Math.floor(DEV_SESSION_TTL_MS / 1000);
  const domain = typeof attrs.domain === "string" && attrs.domain.trim() ? attrs.domain.trim() : null;
  const path = attrs.path || "/";
  const sameSite = String(attrs.sameSite || "lax");
  const header = serializeCookie(cookies.sessionToken.name, signed, {
    domain: domain ?? undefined,
    path,
    maxAge,
    httpOnly: attrs.httpOnly !== false,
    secure: Boolean(attrs.secure),
    sameSite,
  });
  return {
    ok: true,
    user,
    expires_at: expiresAt.getTime(),
    cookie: {
      name: cookies.sessionToken.name,
      value: signed,
      domain,
      path,
      secure: Boolean(attrs.secure),
      http_only: attrs.httpOnly !== false,
      same_site: sameSite,
      max_age: maxAge,
      header,
    },
  };
}
