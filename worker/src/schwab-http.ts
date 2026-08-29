/**
 * HTTP handlers for Charles Schwab OAuth connect + portfolio / trades reads.
 *
 * GET  /api/schwab/status     — configured + connected (no tokens)
 * GET  /api/schwab/connect    — start OAuth (session required) → Schwab
 * GET  /api/schwab/callback   — code exchange → redirect to /account|/portfolio
 * POST /api/schwab/disconnect — drop stored tokens
 * GET  /api/schwab/portfolio  — linked accounts, balances, positions (no tokens)
 * GET  /api/schwab/trades     — historical TRADE transactions (≤366 days)
 * GET  /api/schwab/pnl        — realized trading PnL time series (MTD/YTD/…)
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
import { loadSchwabPortfolio } from "./schwab-portfolio";
import { loadSchwabPnl, resolvePnlRange } from "./schwab-pnl";
import { loadSchwabTrades, parseTradeDateRange } from "./schwab-trader";
import { getSessionUser } from "./auth";
import { adminTokenAuthorized } from "./bots";

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

function schwabLoadError(
  result:
    | { ok: false; reason: "not_connected" }
    | { ok: false; reason: "refresh_failed" | "upstream"; status: number; message: string },
): Response {
  if (result.reason === "not_connected") {
    return json({ error: "schwab_not_connected", connected: false }, 409);
  }
  if (result.reason === "refresh_failed") {
    return json(
      { error: "schwab_reauth_required", connected: true, detail: result.message.slice(0, 200) },
      401,
    );
  }
  const status = result.status >= 400 && result.status < 600 ? result.status : 502;
  if (status === 401 || status === 403) {
    return json(
      { error: "schwab_reauth_required", connected: true, detail: result.message.slice(0, 200) },
      401,
    );
  }
  return json(
    { error: "schwab_upstream", detail: result.message.slice(0, 200) },
    status === 429 ? 429 : 502,
  );
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

  if (path === "/api/schwab/portfolio" && req.method === "GET") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();

    const result = await loadSchwabPortfolio(env, user.id);
    if (!result.ok) return schwabLoadError(result);
    return json({ ok: true, ...result.view });
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

    const result = await loadSchwabTrades(env, user.id, {
      start: range.start,
      end: range.end,
      accountId: url.searchParams.get("account"),
      symbol: url.searchParams.get("symbol"),
    });
    if (!result.ok) {
      if (result.reason === "bad_request") return json({ error: result.message }, 400);
      return schwabLoadError(result);
    }
    return json({ ok: true, ...result.view });
  }

  if (path === "/api/schwab/pnl" && req.method === "GET") {
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const user = await getSessionUser(env, req);
    if (!user) return unauthorized();

    const url = new URL(req.url);
    const range = resolvePnlRange(url.searchParams.get("range"));
    if ("error" in range) return json({ error: range.error }, 400);

    const result = await loadSchwabPnl(env, user.id, {
      range: range.range,
      start: range.start,
      end: range.end,
      accountId: url.searchParams.get("account"),
    });
    if (!result.ok) {
      if (result.reason === "bad_request") return json({ error: result.message }, 400);
      console.error("schwab pnl request failed", {
        reason: result.reason,
        status: "status" in result ? result.status : undefined,
        message: "message" in result ? result.message.slice(0, 300) : undefined,
        range: range.range,
      });
      return schwabLoadError(result);
    }
    return json({ ok: true, ...result.view });
  }

  // Admin diagnostic: run PnL / trades for a user_id using their stored Schwab
  // connection (Bearer ADMIN_TOKEN). Tokens never leave the Worker.
  if (path === "/api/admin/schwab/pnl" && req.method === "GET") {
    if (!adminTokenAuthorized(req, env)) return unauthorized();
    if (!schwabConfigured(env)) {
      return json({ error: "Schwab is not configured on this deployment" }, 503);
    }
    const url = new URL(req.url);
    const userId = url.searchParams.get("user_id")?.trim();
    if (!userId) return json({ error: "user_id is required" }, 400);
    const range = resolvePnlRange(url.searchParams.get("range"));
    if ("error" in range) return json({ error: range.error }, 400);

    const status = await getSchwabConnectionStatus(env, { id: userId, email: "", name: "" });
    const result = await loadSchwabPnl(env, userId, {
      range: range.range,
      start: range.start,
      end: range.end,
      accountId: url.searchParams.get("account"),
    });
    if (!result.ok) {
      if (result.reason === "bad_request") return json({ error: result.message }, 400);
      return schwabLoadError(result);
    }

    // Companion trades for spot-checking FIFO / assignment. Optional
    // trade_start/trade_end (YYYY-MM-DD) narrow the window; default = chart range.
    // symbol= filters (substring, case-insensitive). limit caps rows (default 80, max 400).
    const tradeStart = url.searchParams.get("trade_start")?.trim() || range.start;
    const tradeEnd = url.searchParams.get("trade_end")?.trim() || range.end;
    const symbolFilter = url.searchParams.get("symbol")?.trim().toUpperCase() || null;
    const limitRaw = Number(url.searchParams.get("limit") ?? "80");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(400, Math.max(1, Math.floor(limitRaw)))
      : 80;

    const tradesResult = await loadSchwabTrades(env, userId, {
      start: tradeStart,
      end: tradeEnd,
      accountId: result.view.account,
      symbol: symbolFilter && !symbolFilter.includes(" ") ? symbolFilter : null,
    });
    const sampleTrades =
      tradesResult.ok
        ? tradesResult.view.trades
            .filter((t) => {
              if (!symbolFilter) return true;
              const sym = (t.symbol ?? "").toUpperCase();
              const und = (t.underlying ?? "").toUpperCase();
              return sym.includes(symbolFilter) || und.includes(symbolFilter);
            })
            .slice(0, limit)
            .map((t) => ({
              id: t.id,
              trade_date: t.trade_date,
              side: t.side,
              symbol: t.symbol,
              underlying: t.underlying,
              quantity: t.quantity,
              price: t.price,
              net_amount: t.net_amount,
              fees: t.fees,
              position_effect: t.position_effect,
              asset_type: t.asset_type,
              activity_type: t.activity_type,
              description: t.description,
            }))
        : [];

    return json({
      ok: true,
      user_id: userId,
      connection: status,
      pnl: result.view,
      sample_trades: sampleTrades,
      sample_trades_error: tradesResult.ok
        ? null
        : tradesResult.reason === "bad_request"
          ? tradesResult.message
          : tradesResult.reason,
    });
  }

  return null;
}
