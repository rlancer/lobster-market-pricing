/**
 * HTTP handlers for Charles Schwab OAuth + trader reads.
 *
 * GET  /api/schwab/status     — configured + connected (no tokens)
 * GET  /api/schwab/connect    — start OAuth (session required) → Schwab
 * GET  /api/schwab/callback   — code exchange → redirect to /account|/portfolio
 * POST /api/schwab/disconnect — drop stored tokens
 * GET  /api/schwab/accounts   — linked brokerage accounts (hashed ids)
 * GET  /api/schwab/trades     — historical TRADE transactions for an account
 */

import {
  accountRedirect,
  buildAuthorizeUrl,
  createOAuthState,
  deleteSchwabConnection,
  exchangeAuthorizationCode,
  getSchwabConnectionStatus,
  getValidSchwabAccessToken,
  sanitizeReturnTo,
  schwabConfigured,
  schwabRedirectUri,
  upsertSchwabConnection,
  verifyOAuthState,
  type SchwabEnv,
} from "./schwab";
import {
  listSchwabAccountNumbers,
  listSchwabTransactions,
  normalizeTrade,
  parseTradeDateRange,
  toAccountSummaries,
  SchwabApiError,
  type SchwabTrade,
} from "./schwab-trader";
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

function schwabUpstreamError(e: unknown): Response {
  if (e instanceof SchwabApiError) {
    const status = e.status === 401 || e.status === 403 ? 502 : e.status >= 400 && e.status < 500 ? 400 : 502;
    return json({ error: e.message, schwab_status: e.status }, status);
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "schwab_not_connected") {
    return json({ error: "Schwab is not connected", code: "schwab_not_connected" }, 409);
  }
  if (/token refresh failed/i.test(msg) || /token exchange failed/i.test(msg)) {
    return json({ error: "Schwab session expired — reconnect on Account", code: "schwab_reauth" }, 401);
  }
  console.error("schwab upstream failed", e);
  return json({ error: "Schwab request failed" }, 502);
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

  if (path === "/api/schwab/accounts" && req.method === "GET") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();
    try {
      const accessToken = await getValidSchwabAccessToken(env, user.id);
      const rows = await listSchwabAccountNumbers(accessToken);
      return json({ ok: true, accounts: toAccountSummaries(rows) });
    } catch (e) {
      return schwabUpstreamError(e);
    }
  }

  if (path === "/api/schwab/trades" && req.method === "GET") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();

    const url = new URL(req.url);
    const range = parseTradeDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
    if ("error" in range) return json({ error: range.error }, 400);

    const symbol = url.searchParams.get("symbol");
    let accountHash = url.searchParams.get("account")?.trim() || "";

    try {
      const accessToken = await getValidSchwabAccessToken(env, user.id);
      const accounts = toAccountSummaries(await listSchwabAccountNumbers(accessToken));
      if (accounts.length === 0) {
        return json({ ok: true, accounts: [], account: null, start: range.start, end: range.end, trades: [] as SchwabTrade[] });
      }
      if (!accountHash) accountHash = accounts[0]!.hash;
      if (!accounts.some((a) => a.hash === accountHash)) {
        return json({ error: "unknown Schwab account" }, 400);
      }

      const raw = await listSchwabTransactions(accessToken, accountHash, {
        start: range.start,
        end: range.end,
        types: "TRADE",
        symbol: symbol ?? undefined,
      });
      const trades = raw.map(normalizeTrade).sort((a, b) => {
        const ta = a.trade_date ?? "";
        const tb = b.trade_date ?? "";
        return tb.localeCompare(ta);
      });

      return json({
        ok: true,
        accounts,
        account: accountHash,
        start: range.start,
        end: range.end,
        symbol: symbol?.trim().toUpperCase() || null,
        trades,
        /** Schwab may silently truncate around 3000 rows. */
        may_be_truncated: trades.length >= 3000,
      });
    } catch (e) {
      return schwabUpstreamError(e);
    }
  }

  return null;
}
