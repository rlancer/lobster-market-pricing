/**
 * Persist timeline quality-gate decisions so admins can watch the monitor.
 *
 * Console logs disappear; this D1 ledger is the source for
 * GET /api/admin/quality-gate (allow/reject, fail-open, remediator unlists,
 * improvement tickets).
 */
import type { ImprovementAction } from "./improvement-reporter";
import type { TimelineModerationDecision } from "./timeline-moderation";

export const QUALITY_GATE_LIST_DEFAULT = 50;
export const QUALITY_GATE_LIST_MAX = 100;
export const QUALITY_GATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type QualityGateAction =
  | ImprovementAction
  | "unlist_qa_share"
  | "remoderate_unlist"
  | "read_unlist"
  | "remediator_sweep";

export type QualityGateEventInput = {
  action: QualityGateAction;
  decision?: Pick<TimelineModerationDecision, "allow" | "reason"> & { source: string } | null;
  shareId?: string | null;
  runId?: string | null;
  botHandle?: string | null;
  model?: string | null;
  extra?: Record<string, unknown> | null;
};

export type QualityGateEvent = {
  event_id: string;
  created_at: number;
  action: string;
  allow: boolean | null;
  source: string | null;
  reason: string | null;
  share_id: string | null;
  run_id: string | null;
  bot_handle: string | null;
  model: string | null;
  extra: Record<string, unknown> | null;
};

export type QualityGateSummary = {
  window_ms: number;
  decisions: number;
  allowed: number;
  rejected: number;
  fail_open: number;
  remediator_unlisted: number;
  last_sweep: { created_at: number; scanned: number; unlisted: number } | null;
};

export type ImprovementReportRow = {
  fingerprint: string;
  title: string;
  category: string | null;
  issue_number: number | null;
  issue_url: string | null;
  share_id: string | null;
  bot_handle: string | null;
  moderation_action: string | null;
  moderation_allow: boolean | null;
  created_at: number;
};

export type QualityGateListQuery = {
  limit: number;
  action: string | null;
  source: string | null;
};

function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function parseExtra(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asEvent(row: {
  event_id: string;
  created_at: number;
  action: string;
  allow: number | null;
  source: string | null;
  reason: string | null;
  share_id: string | null;
  run_id: string | null;
  bot_handle: string | null;
  model: string | null;
  extra_json: string | null;
}): QualityGateEvent {
  return {
    event_id: row.event_id,
    created_at: row.created_at,
    action: row.action,
    allow: row.allow == null ? null : Number(row.allow) === 1,
    source: row.source,
    reason: row.reason,
    share_id: row.share_id,
    run_id: row.run_id,
    bot_handle: row.bot_handle,
    model: row.model,
    extra: parseExtra(row.extra_json),
  };
}

export function parseQualityGateListQuery(url: URL): QualityGateListQuery {
  const rawLimit = Number(url.searchParams.get("limit") || QUALITY_GATE_LIST_DEFAULT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.floor(rawLimit), QUALITY_GATE_LIST_MAX))
    : QUALITY_GATE_LIST_DEFAULT;
  const action = url.searchParams.get("action")?.trim() || null;
  const source = url.searchParams.get("source")?.trim() || null;
  return { limit, action, source };
}

/** Never throws — a ledger miss must not fail mint / unlist. */
export async function recordQualityGateEvent(
  db: D1Database,
  input: QualityGateEventInput,
): Promise<void> {
  try {
    const extraJson = input.extra && Object.keys(input.extra).length
      ? JSON.stringify(input.extra).slice(0, 2_000)
      : null;
    const allow = input.decision
      ? (input.decision.allow ? 1 : 0)
      : input.action === "remediator_sweep"
        ? null
        : input.action.startsWith("allow_")
          ? 1
          : input.action.includes("reject") || input.action.includes("unlist")
            ? 0
            : null;
    await db.prepare(
      `INSERT INTO quality_gate_events
         (event_id, created_at, action, allow, source, reason, share_id, run_id, bot_handle, model, extra_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      newEventId(),
      Date.now(),
      input.action,
      allow,
      input.decision?.source ?? (input.action === "remediator_sweep" ? "heuristic" : null),
      (input.decision?.reason ?? null)?.slice(0, 500) ?? null,
      input.shareId ?? null,
      input.runId ?? null,
      input.botHandle ?? null,
      input.model ?? null,
      extraJson,
    ).run();
  } catch (error) {
    console.warn(JSON.stringify({
      qualityGateLog: true,
      action: "insert_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function listQualityGateEvents(
  db: D1Database,
  query: QualityGateListQuery,
): Promise<QualityGateEvent[]> {
  const clauses = ["1 = 1"];
  const binds: unknown[] = [];
  if (query.action) {
    binds.push(query.action);
    clauses.push(`action = ?${binds.length}`);
  } else {
    clauses.push(`action != 'remediator_sweep'`);
  }
  if (query.source) {
    binds.push(query.source);
    clauses.push(`source = ?${binds.length}`);
  }
  binds.push(query.limit);
  const rows = await db.prepare(
    `SELECT event_id, created_at, action, allow, source, reason,
            share_id, run_id, bot_handle, model, extra_json
     FROM quality_gate_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?${binds.length}`,
  ).bind(...binds).all<{
    event_id: string;
    created_at: number;
    action: string;
    allow: number | null;
    source: string | null;
    reason: string | null;
    share_id: string | null;
    run_id: string | null;
    bot_handle: string | null;
    model: string | null;
    extra_json: string | null;
  }>();
  return (rows.results ?? []).map(asEvent);
}

export async function summarizeQualityGate(
  db: D1Database,
  windowMs = QUALITY_GATE_WINDOW_MS,
): Promise<QualityGateSummary> {
  const since = Date.now() - windowMs;
  const counts = await db.prepare(
    `SELECT
       COUNT(*) AS decisions,
       SUM(CASE WHEN allow = 1 THEN 1 ELSE 0 END) AS allowed,
       SUM(CASE WHEN allow = 0 THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN source = 'fail_open' THEN 1 ELSE 0 END) AS fail_open,
       SUM(CASE WHEN action IN ('remoderate_unlist', 'read_unlist') THEN 1 ELSE 0 END) AS remediator_unlisted
     FROM quality_gate_events
     WHERE created_at > ?1 AND action != 'remediator_sweep'`,
  ).bind(since).first<{
    decisions: number | null;
    allowed: number | null;
    rejected: number | null;
    fail_open: number | null;
    remediator_unlisted: number | null;
  }>();
  const sweep = await db.prepare(
    `SELECT created_at, extra_json FROM quality_gate_events
     WHERE action = 'remediator_sweep'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).first<{ created_at: number; extra_json: string | null }>();
  const extra = parseExtra(sweep?.extra_json ?? null);
  const scanned = typeof extra?.scanned === "number" ? extra.scanned : 0;
  const unlisted = typeof extra?.unlisted === "number" ? extra.unlisted : 0;
  return {
    window_ms: windowMs,
    decisions: Number(counts?.decisions ?? 0),
    allowed: Number(counts?.allowed ?? 0),
    rejected: Number(counts?.rejected ?? 0),
    fail_open: Number(counts?.fail_open ?? 0),
    remediator_unlisted: Number(counts?.remediator_unlisted ?? 0),
    last_sweep: sweep
      ? { created_at: sweep.created_at, scanned, unlisted }
      : null,
  };
}

export async function listImprovementReports(
  db: D1Database,
  limit = 20,
): Promise<ImprovementReportRow[]> {
  const cap = Math.max(1, Math.min(limit, 50));
  const rows = await db.prepare(
    `SELECT fingerprint, title, category, issue_number, issue_url,
            share_id, bot_handle, moderation_action, moderation_allow, created_at
     FROM improvement_reports
     ORDER BY created_at DESC
     LIMIT ?1`,
  ).bind(cap).all<{
    fingerprint: string;
    title: string;
    category: string | null;
    issue_number: number | null;
    issue_url: string | null;
    share_id: string | null;
    bot_handle: string | null;
    moderation_action: string | null;
    moderation_allow: number | null;
    created_at: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    fingerprint: row.fingerprint,
    title: row.title,
    category: row.category,
    issue_number: row.issue_number,
    issue_url: row.issue_url,
    share_id: row.share_id,
    bot_handle: row.bot_handle,
    moderation_action: row.moderation_action,
    moderation_allow: row.moderation_allow == null ? null : Number(row.moderation_allow) === 1,
    created_at: row.created_at,
  }));
}
