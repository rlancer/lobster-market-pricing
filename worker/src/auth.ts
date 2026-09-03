/**
 * Better Auth on SCHEMA_DB (Google OAuth, HttpOnly session cookie).
 *
 * The Worker is the only thing that ever writes user_id. Chat stays anonymous
 * by default; login is optional. Cookie Domain is derived from the request
 * host so lobster.mp / api.lobster.mp (and the matching *-dev siblings) share
 * a parent-domain cookie, while localhost stays host-only.
 */
import { betterAuth } from "better-auth";
import { isAdminEmail } from "./admin";

export interface AuthEnv {
  SCHEMA_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_TOKEN?: string;
  /** Preview Worker only (`wrangler.jsonc` env.dev). Production must omit this. */
  ALLOW_DEV_IMPERSONATION?: string;
}

export const DEV_AS_HEADER = "X-Dev-As";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

const DEFAULT_TRUSTED_ORIGINS = [
  "https://lobster.mp",
  "https://www.lobster.mp",
  "https://dev.lobster.mp",
  "https://robs-options-slop.pages.dev",
  "https://robs-options-slop-dev.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function googleConfigured(env: AuthEnv): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim() && env.BETTER_AUTH_SECRET?.trim());
}

export function cookieDomainFor(requestUrl: string): string | undefined {
  try {
    const host = new URL(requestUrl).hostname;
    if (host === "lobster.mp" || host.endsWith(".lobster.mp")) return "lobster.mp";
  } catch {
    /* ignore */
  }
  return undefined;
}

export function isTrustedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (DEFAULT_TRUSTED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname;
    if (host === "lobster.mp" || host.endsWith(".lobster.mp")) return true;
    if (host.endsWith(".robs-options-slop-dev.pages.dev") || host.endsWith(".robs-options-slop.pages.dev")) return true;
    if ((host === "localhost" || host === "127.0.0.1") && url.protocol === "http:") return true;
  } catch {
    return false;
  }
  return false;
}

export function trustedOrigins(requestUrl: string, requestOrigin: string | null): string[] {
  const origins = new Set(DEFAULT_TRUSTED_ORIGINS);
  try {
    origins.add(new URL(requestUrl).origin);
  } catch {
    /* ignore */
  }
  if (requestOrigin && isTrustedOrigin(requestOrigin)) origins.add(requestOrigin);
  return [...origins];
}

export function createAuth(env: AuthEnv, req: Request) {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;
  const baseURL = new URL(req.url).origin;
  const cookieDomain = cookieDomainFor(req.url);
  const googleId = env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return betterAuth({
    database: env.SCHEMA_DB,
    secret,
    baseURL,
    basePath: "/api/auth",
    trustedOrigins: trustedOrigins(req.url, req.headers.get("Origin")),
    telemetry: { enabled: false },
    emailAndPassword: { enabled: false },
    socialProviders: googleId && googleSecret
      ? {
          google: {
            clientId: googleId,
            clientSecret: googleSecret,
            prompt: "select_account",
          },
        }
      : undefined,
    advanced: {
      useSecureCookies: cookieDomain ? true : undefined,
      cookiePrefix: "lobster",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: Boolean(cookieDomain),
        path: "/",
      },
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
    },
  });
}

function secureEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function isDevImpersonationHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === "api.lobster.mp" || host === "lobster.mp" || host === "www.lobster.mp") return false;
  if (host === "api-dev.lobster.mp") return true;
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".workers.dev") && /(^|\.)screener-api-dev(\.|$)/.test(host)) return true;
  return false;
}

export function impersonationAllowed(
  env: Pick<AuthEnv, "ALLOW_DEV_IMPERSONATION">,
  hostname: string,
): boolean {
  if (env.ALLOW_DEV_IMPERSONATION !== "1") return false;
  return isDevImpersonationHost(hostname);
}

export function parseDevAsEmail(raw: string | null | undefined): string | null {
  const email = raw?.trim().toLowerCase() ?? "";
  if (!email.includes("@")) return null;
  if (!isAdminEmail(email)) return null;
  return email;
}

function adminBearerOk(req: Request, env: AuthEnv): boolean {
  const expected = env.ADMIN_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return token.length > 0 && secureEqual(token, expected);
}

export async function findUserByEmail(db: D1Database, email: string): Promise<SessionUser | null> {
  const row = await db.prepare(
    `SELECT id, name, email, image FROM "user" WHERE lower(email) = lower(?1) LIMIT 1`,
  ).bind(email).first<{ id: string; name: string; email: string; image: string | null }>();
  if (!row?.id) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  };
}

export async function getSessionUser(env: AuthEnv, req: Request): Promise<SessionUser | null> {
  try {
    const host = new URL(req.url).hostname;
    if (impersonationAllowed(env, host) && adminBearerOk(req, env)) {
      const asEmail = parseDevAsEmail(req.headers.get(DEV_AS_HEADER));
      if (asEmail) {
        const impersonated = await findUserByEmail(env.SCHEMA_DB, asEmail);
        if (impersonated) return impersonated;
      }
    }
  } catch {
    /* fall through to a normal session */
  }
  const auth = createAuth(env, req);
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: req.headers });
  const user = session?.user;
  if (!user?.id) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
  };
}
