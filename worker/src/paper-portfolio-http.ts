/**
 * HTTP handlers for the signed-in paper portfolio.
 *
 * GET  /api/portfolio              — account + positions (live marks)
 * POST /api/portfolio/track        — open a position from a suggested trade
 * POST /api/portfolio/positions/:id/close — close + realize PnL
 * GET  /api/portfolio/positions/:id/marks — daily mark history + day PnL
 */

import { getSessionUser } from "./auth";
import {
  closePosition,
  listPortfolio,
  parseConviction,
  parseTrackBody,
  trackSuggestion,
  type LakeSql,
} from "./paper-portfolio";
import { listPositionMarkHistory } from "./position-mark-history";

type PortfolioEnv = {
  SCHEMA_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

function json(data: unknown, status = 200, cache: "public" | "private" = "public"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cache === "private" ? "private, no-store" : "public, max-age=60",
    },
  });
}

export async function handlePortfolio(
  env: PortfolioEnv,
  req: Request,
  path: string,
  lake: LakeSql,
): Promise<Response | null> {
  if (path === "/api/portfolio" && req.method === "GET") {
    const user = await getSessionUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401, "private");
    const url = new URL(req.url);
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw === "open" || statusRaw === "closed" || statusRaw === "all"
      ? statusRaw
      : "all";
    const conviction = parseConviction(url.searchParams.get("conviction"));
    const refresh = url.searchParams.get("refresh") !== "0";
    const view = await listPortfolio(env.SCHEMA_DB, lake, user.id, {
      status,
      conviction,
      refreshMarks: refresh,
    });
    return json({ ok: true, ...view }, 200, "private");
  }

  if (path === "/api/portfolio/track" && req.method === "POST") {
    const user = await getSessionUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401, "private");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400, "private");
    }
    const parsed = parseTrackBody(body);
    if ("error" in parsed) return json({ error: parsed.error }, 400, "private");
    const result = await trackSuggestion(env.SCHEMA_DB, lake, user.id, parsed);
    if (!result.ok) return json({ error: result.error }, result.status, "private");
    return json({
      ok: true,
      created: result.created,
      position: result.position,
      account_cash: result.account_cash,
    }, result.created ? 201 : 200, "private");
  }

  const marksMatch = path.match(/^\/api\/portfolio\/positions\/([^/]+)\/marks$/);
  if (marksMatch && req.method === "GET") {
    const user = await getSessionUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401, "private");
    const positionId = decodeURIComponent(marksMatch[1]!);
    const owned = await env.SCHEMA_DB.prepare(
      `SELECT id FROM paper_positions WHERE id = ?1 AND user_id = ?2`,
    ).bind(positionId, user.id).first<{ id: string }>();
    if (!owned) return json({ error: "position not found" }, 404, "private");
    const marks = await listPositionMarkHistory(env.SCHEMA_DB, "paper", positionId);
    return json({ ok: true, position_id: positionId, marks }, 200, "private");
  }

  const closeMatch = path.match(/^\/api\/portfolio\/positions\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    const user = await getSessionUser(env, req);
    if (!user) return json({ error: "unauthorized" }, 401, "private");
    const positionId = decodeURIComponent(closeMatch[1]!);
    const result = await closePosition(env.SCHEMA_DB, lake, user.id, positionId);
    if (!result.ok) return json({ error: result.error }, result.status, "private");
    return json({
      ok: true,
      position: result.position,
      account_cash: result.account_cash,
    }, 200, "private");
  }

  return null;
}
