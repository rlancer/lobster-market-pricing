/**
 * HTTP handlers for Charles Schwab OAuth connect.
 *
 * GET  /api/schwab/status     — configured + connected (no tokens)
 * GET  /api/schwab/connect    — start OAuth (session required) → Schwab
 * GET  /api/schwab/callback   — code exchange → redirect to /account
 * POST /api/schwab/disconnect — drop stored tokens
 */

import {
  accountRedirect,
  buildAuthorizeUrl,
  createOAuthState,
  deleteSchwabConnection,
  exchangeAuthorizationCode,
  getSchwabConnectionStatus,
  sanitizeReturnTo,
  schwabConfigured,
  schwabRedirectUri,
  upsertSchwabConnection,
  verifyOAuthState,
  type SchwabEnv,
} from "./schwab";
import { getSessionUser } from "./auth";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

function frontendOriginHint(req: Request): string {
  const origin = req.headers.get("Origin");
  if (origin) return origin;
  const referer = req.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      /* ignore */
    }
  }
  const host = new URL(req.url).hostname;
  if (host === "api.lobster.mp") return "https://lobster.mp";
  if (host === "api-dev.lobster.mp") return "https://dev.lobster.mp";
  if (host === "127.0.0.1" || host === "localhost") return "http://127.0.0.1:5173";
  return new URL(req.url).origin;
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

export async function handleSchwab(
  env: SchwabEnv,
  req: Request,
  path: string,
): Promise<Response | null> {
  if (path === "/api/schwab/status" && req.method === "GET") {
    const user = await getSessionUser(env, req);
    return json({ ok: true, ...(await getSchwabConnectionStatus(env, user)) });
  }

  if (path === "/api/schwab/connect" && req.method === "GET") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const secret = env.BETTER_AUTH_SECRET?.trim();
    if (!secret) return json({ error: "auth is not configured" }, 503);

    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();

    const url = new URL(req.url);
    const returnTo = sanitizeReturnTo(url.searchParams.get("return_to"), frontendOriginHint(req));
    const redirectUri = schwabRedirectUri(env, req.url);
    const state = await createOAuthState(secret, user.id, returnTo);
    const authorize = buildAuthorizeUrl({
      clientId: env.SCHWAB_CLIENT_ID!.trim(),
      redirectUri,
      state,
    });
    return Response.redirect(authorize, 302);
  }

  if (path === "/api/schwab/callback" && req.method === "GET") {
    const url = new URL(req.url);
    const fallback = sanitizeReturnTo(null, frontendOriginHint(req));
    const err = url.searchParams.get("error");
    if (err) {
      return accountRedirect(fallback, {
        schwab: "error",
        schwab_error: err.slice(0, 80),
      });
    }

    const secret = env.BETTER_AUTH_SECRET?.trim();
    if (!secret || !schwabConfigured(env)) {
      return accountRedirect(fallback, { schwab: "error", schwab_error: "not_configured" });
    }

    const stateRaw = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const state = await verifyOAuthState(secret, stateRaw);
    if (!state || !code) {
      return accountRedirect(fallback, { schwab: "error", schwab_error: "invalid_state" });
    }

    const returnTo = sanitizeReturnTo(state.returnTo, frontendOriginHint(req));
    // Session must still match the user who started connect (CSRF + account bind).
    const user = await getSessionUser(env, req);
    if (!user) {
      return accountRedirect(returnTo, { schwab: "error", schwab_error: "signed_out" });
    }
    if (user.id !== state.userId) {
      return accountRedirect(returnTo, { schwab: "error", schwab_error: "user_mismatch" });
    }

    try {
      const redirectUri = schwabRedirectUri(env, req.url);
      const tokens = await exchangeAuthorizationCode(env, code, redirectUri);
      await upsertSchwabConnection(env.SCHEMA_DB, user.id, tokens);
      return accountRedirect(returnTo, { schwab: "connected" });
    } catch (e) {
      console.error("schwab callback failed", e);
      return accountRedirect(returnTo, { schwab: "error", schwab_error: "token_exchange" });
    }
  }

  if (path === "/api/schwab/disconnect" && req.method === "POST") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();
    await deleteSchwabConnection(env.SCHEMA_DB, user.id);
    return json({ ok: true, connected: false });
  }

  return null;
}
