/**
 * Charles Schwab Trader API OAuth (authorization-code).
 *
 * Endpoints: https://api.schwabapi.com/v1/oauth/{authorize,token}
 * Tokens live in SCHEMA_DB (schwab_connections) and are never sent to the browser.
 */

import { isTrustedOrigin, type AuthEnv, type SessionUser } from "./auth";

export const SCHWAB_AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
export const SCHWAB_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

/** Default Trader API scope used by most Schwab apps. */
export const SCHWAB_DEFAULT_SCOPE = "api";

const STATE_TTL_MS = 15 * 60 * 1000;

export interface SchwabEnv extends AuthEnv {
  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
  /** Optional override; must match a Callback URL registered in the Schwab portal. */
  SCHWAB_REDIRECT_URI?: string;
}

export interface SchwabConnectionStatus {
  configured: boolean;
  connected: boolean;
  connected_at: string | null;
  expires_at: string | null;
}

export interface SchwabTokenRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  scope: string | null;
  expires_at: number;
  connected_at: number;
  updated_at: number;
}

export function schwabConfigured(env: SchwabEnv): boolean {
  return Boolean(env.SCHWAB_CLIENT_ID?.trim() && env.SCHWAB_CLIENT_SECRET?.trim());
}

export function schwabRedirectUri(env: SchwabEnv, requestUrl: string): string {
  const override = env.SCHWAB_REDIRECT_URI?.trim();
  if (override) return override;
  return `${new URL(requestUrl).origin}/api/schwab/callback`;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: opts.scope ?? SCHWAB_DEFAULT_SCOPE,
    state: opts.state,
  });
  return `${SCHWAB_AUTHORIZE_URL}?${params.toString()}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function fromB64url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(secret: string, payloadB64: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return b64url(new Uint8Array(sig));
}

export interface SchwabOAuthState {
  userId: string;
  returnTo: string;
  exp: number;
  nonce: string;
}

/** Post-OAuth landing paths we allow (connect can start from Account or Portfolio). */
const SCHWAB_RETURN_PATHS = new Set(["/account", "/portfolio"]);

export function sanitizeReturnTo(raw: string | null | undefined, fallbackOrigin: string): string {
  const fallback = `${fallbackOrigin.replace(/\/$/, "")}/account`;
  if (!raw?.trim()) return fallback;
  try {
    const url = new URL(raw.trim());
    if (!isTrustedOrigin(url.origin)) return fallback;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    url.pathname = SCHWAB_RETURN_PATHS.has(path) ? path : "/account";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

export async function createOAuthState(
  secret: string,
  userId: string,
  returnTo: string,
  now = Date.now(),
): Promise<string> {
  const payload: SchwabOAuthState = {
    userId,
    returnTo,
    exp: now + STATE_TTL_MS,
    nonce: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payloadB64 = b64urlFromString(JSON.stringify(payload));
  const sig = await signPayload(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export async function verifyOAuthState(
  secret: string,
  state: string,
  now = Date.now(),
): Promise<SchwabOAuthState | null> {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;
  const expected = await signPayload(secret, payloadB64);
  if (expected.length !== sig.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (mismatch !== 0) return null;
  let payload: SchwabOAuthState;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64))) as SchwabOAuthState;
  } catch {
    return null;
  }
  if (!payload?.userId || !payload.returnTo || typeof payload.exp !== "number") return null;
  if (payload.exp < now) return null;
  return payload;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export interface SchwabTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

async function postTokenRequest(
  env: SchwabEnv,
  body: URLSearchParams,
  label: string,
): Promise<SchwabTokenResponse> {
  const clientId = env.SCHWAB_CLIENT_ID!.trim();
  const clientSecret = env.SCHWAB_CLIENT_SECRET!.trim();
  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${label} failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const json = (await resp.json()) as SchwabTokenResponse;
  if (!json.access_token) {
    throw new Error(`${label} response missing access_token`);
  }
  return json;
}

export async function exchangeAuthorizationCode(
  env: SchwabEnv,
  code: string,
  redirectUri: string,
): Promise<SchwabTokenResponse> {
  // Schwab returns code with a trailing @ often percent-encoded as %40.
  const decoded = decodeURIComponent(code.trim());
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: decoded,
    redirect_uri: redirectUri,
  });
  const json = await postTokenRequest(env, body, "Schwab token exchange");
  if (!json.refresh_token) {
    throw new Error("Schwab token response missing refresh_token");
  }
  return json;
}

export async function refreshSchwabAccessToken(
  env: SchwabEnv,
  refreshToken: string,
): Promise<SchwabTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return postTokenRequest(env, body, "Schwab token refresh");
}

const ACCESS_TOKEN_SKEW_MS = 60_000;

export async function getSchwabTokenRow(
  db: D1Database,
  userId: string,
): Promise<SchwabTokenRow | null> {
  return db
    .prepare(
      `SELECT user_id, access_token, refresh_token, token_type, scope,
              expires_at, connected_at, updated_at
       FROM schwab_connections WHERE user_id = ?`,
    )
    .bind(userId)
    .first<SchwabTokenRow>();
}

/**
 * Return a usable Bearer access token, refreshing when near expiry.
 * Throws if the user has no connection or refresh fails.
 */
export async function getValidSchwabAccessToken(
  env: SchwabEnv,
  userId: string,
  now = Date.now(),
): Promise<string> {
  const row = await getSchwabTokenRow(env.SCHEMA_DB, userId);
  if (!row) throw new Error("schwab_not_connected");
  if (row.expires_at > now + ACCESS_TOKEN_SKEW_MS) return row.access_token;

  const tokens = await refreshSchwabAccessToken(env, row.refresh_token);
  // Schwab sometimes omits a new refresh_token on refresh — keep the old one.
  const merged: SchwabTokenResponse = {
    ...tokens,
    refresh_token: tokens.refresh_token || row.refresh_token,
  };
  await upsertSchwabConnection(env.SCHEMA_DB, userId, merged, now);
  return merged.access_token;
}

export async function upsertSchwabConnection(
  db: D1Database,
  userId: string,
  tokens: SchwabTokenResponse,
  now = Date.now(),
): Promise<void> {
  const expiresAt = now + Math.max(60, Number(tokens.expires_in ?? 1800)) * 1000;
  const existing = await db
    .prepare("SELECT connected_at, refresh_token FROM schwab_connections WHERE user_id = ?")
    .bind(userId)
    .first<{ connected_at: number; refresh_token: string }>();
  const connectedAt = existing?.connected_at ?? now;
  const refreshToken = tokens.refresh_token?.trim() || existing?.refresh_token;
  if (!refreshToken) {
    throw new Error("Schwab token response missing refresh_token");
  }
  await db
    .prepare(
      `INSERT INTO schwab_connections (
         user_id, access_token, refresh_token, token_type, scope,
         expires_at, connected_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         token_type = excluded.token_type,
         scope = excluded.scope,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      tokens.access_token,
      refreshToken,
      tokens.token_type ?? "Bearer",
      tokens.scope ?? null,
      expiresAt,
      connectedAt,
      now,
    )
    .run();
}

export async function deleteSchwabConnection(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM schwab_connections WHERE user_id = ?").bind(userId).run();
}

export async function getSchwabConnectionStatus(
  env: SchwabEnv,
  user: SessionUser | null,
): Promise<SchwabConnectionStatus> {
  const configured = schwabConfigured(env);
  if (!user || !configured) {
    return { configured, connected: false, connected_at: null, expires_at: null };
  }
  const row = await env.SCHEMA_DB
    .prepare("SELECT connected_at, expires_at FROM schwab_connections WHERE user_id = ?")
    .bind(user.id)
    .first<{ connected_at: number; expires_at: number }>();
  if (!row) {
    return { configured, connected: false, connected_at: null, expires_at: null };
  }
  return {
    configured,
    connected: true,
    connected_at: new Date(row.connected_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

export function accountRedirect(returnTo: string, query: Record<string, string>): Response {
  const url = new URL(returnTo);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}
