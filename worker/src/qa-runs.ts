/**
 * Admin QA / test-run ledger — batches of off-Floor bot shares.
 *
 * A successful scheduled bot mint stamps `bot_handle` so the share appears
 * on GET /api/timeline. QA runs need a third path: mint the share, keep
 * `bot_runs.status = shared`, leave `bot_handle` null so the Floor never
 * lists it. Metadata (bug, PR) lives here so operators can reopen the
 * unlisted /share/{id} links.
 */

import { clearBotListing } from "./timeline";

export const QA_TITLE_MAX = 200;
export const QA_DESCRIPTION_MAX = 4_000;
export const QA_PR_URL_MAX = 400;
export const QA_VERDICT_JSON_MAX = 20_000;

export interface QaBatch {
  batch_id: string;
  title: string;
  description: string | null;
  pr_url: string | null;
  created_at: number;
  item_count: number;
}

export interface QaItem {
  item_id: string;
  batch_id: string;
  handle: string | null;
  run_id: string | null;
  share_id: string;
  chat_id: string | null;
  status: string;
  listed_on_floor: boolean;
  verdict_ok: boolean | null;
  verdict_json: unknown | null;
  created_at: number;
}

export interface CreateQaBatchInput {
  title: string;
  description: string | null;
  pr_url: string | null;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; status: number };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function clippedString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

export function newQaId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Trigger body: QA batch implies off-Floor unless list_on_floor is explicit true. */
export function parseBotTriggerOptions(body: unknown): {
  listOnFloor: boolean;
  qaBatchId: string | null;
} {
  const rec = isRecord(body) ? body : {};
  const qaBatchId = clippedString(rec.qa_batch_id, 64);
  if (rec.list_on_floor === true) {
    return { listOnFloor: true, qaBatchId };
  }
  if (rec.list_on_floor === false || qaBatchId) {
    return { listOnFloor: false, qaBatchId };
  }
  return { listOnFloor: true, qaBatchId: null };
}

export function parseCreateQaBatch(body: unknown): ParseResult<CreateQaBatchInput> {
  if (!isRecord(body)) return { ok: false, error: "invalid JSON body", status: 400 };
  const title = clippedString(body.title, QA_TITLE_MAX);
  if (!title) return { ok: false, error: "title is required", status: 400 };
  const description = clippedString(body.description, QA_DESCRIPTION_MAX);
  const prUrl = clippedString(body.pr_url, QA_PR_URL_MAX);
  if (prUrl && !/^https:\/\//i.test(prUrl)) {
    return { ok: false, error: "pr_url must be an https URL", status: 400 };
  }
  return { ok: true, value: { title, description, pr_url: prUrl } };
}

export function parseShareIds(raw: unknown): ParseResult<string[]> {
  const collected: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) collected.push(item.trim());
    }
  } else if (typeof raw === "string") {
    for (const part of raw.split(/[\s,]+/)) {
      if (part) collected.push(part);
    }
  } else {
    return { ok: false, error: "share_ids must be a string or array", status: 400 };
  }
  const ids = [...new Set(collected.map((id) => id.replace(/^.*\/share\//, "")))].filter(Boolean);
  if (ids.length === 0) return { ok: false, error: "share_ids is empty", status: 400 };
  if (ids.length > 50) return { ok: false, error: "share_ids cap is 50", status: 400 };
  return { ok: true, value: ids };
}

export function parseQaVerdict(body: unknown): ParseResult<{
  verdict_ok: boolean | null;
  verdict_json: string | null;
}> {
  if (!isRecord(body)) return { ok: false, error: "invalid JSON body", status: 400 };
  let verdictOk: boolean | null = null;
  if (body.verdict_ok === true || body.verdict_ok === false) {
    verdictOk = body.verdict_ok;
  } else if (body.verdict_ok != null) {
    return { ok: false, error: "verdict_ok must be boolean", status: 400 };
  }
  let verdictJson: string | null = null;
  if (body.verdict != null || body.verdict_json != null) {
    const payload = body.verdict ?? body.verdict_json;
    try {
      verdictJson = JSON.stringify(payload);
    } catch {
      return { ok: false, error: "verdict is not JSON-serializable", status: 400 };
    }
    if (verdictJson.length > QA_VERDICT_JSON_MAX) {
      return { ok: false, error: "verdict is too large", status: 400 };
    }
  }
  return { ok: true, value: { verdict_ok: verdictOk, verdict_json: verdictJson } };
}

function asBatch(row: {
  batch_id: string;
  title: string;
  description: string | null;
  pr_url: string | null;
  created_at: number;
  item_count?: number | null;
}): QaBatch {
  return {
    batch_id: row.batch_id,
    title: row.title,
    description: row.description,
    pr_url: row.pr_url,
    created_at: row.created_at,
    item_count: Number(row.item_count ?? 0),
  };
}

function parseVerdictJson(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function asItem(row: {
  item_id: string;
  batch_id: string;
  handle: string | null;
  run_id: string | null;
  share_id: string;
  chat_id: string | null;
  status: string;
  listed_on_floor?: number | null;
  bot_handle?: string | null;
  verdict_ok: number | null;
  verdict_json: string | null;
  created_at: number;
}): QaItem {
  const listed = row.listed_on_floor != null
    ? Number(row.listed_on_floor) === 1
    : Boolean(row.bot_handle);
  return {
    item_id: row.item_id,
    batch_id: row.batch_id,
    handle: row.handle,
    run_id: row.run_id,
    share_id: row.share_id,
    chat_id: row.chat_id,
    status: row.status,
    listed_on_floor: listed,
    verdict_ok: row.verdict_ok == null ? null : Number(row.verdict_ok) === 1,
    verdict_json: parseVerdictJson(row.verdict_json),
    created_at: row.created_at,
  };
}

export async function createQaBatch(
  db: D1Database,
  input: CreateQaBatchInput,
  now = Date.now(),
): Promise<QaBatch> {
  const batchId = newQaId();
  await db.prepare(
    `INSERT INTO qa_batches (batch_id, title, description, pr_url, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(batchId, input.title, input.description, input.pr_url, now).run();
  return {
    batch_id: batchId,
    title: input.title,
    description: input.description,
    pr_url: input.pr_url,
    created_at: now,
    item_count: 0,
  };
}

export async function getQaBatch(db: D1Database, batchId: string): Promise<QaBatch | null> {
  const row = await db.prepare(
    `SELECT b.batch_id, b.title, b.description, b.pr_url, b.created_at,
            (SELECT COUNT(*) FROM qa_items i WHERE i.batch_id = b.batch_id) AS item_count
       FROM qa_batches b
      WHERE b.batch_id = ?1`,
  ).bind(batchId).first<{
    batch_id: string;
    title: string;
    description: string | null;
    pr_url: string | null;
    created_at: number;
    item_count: number;
  }>();
  return row ? asBatch(row) : null;
}

export async function listQaBatches(db: D1Database): Promise<QaBatch[]> {
  const res = await db.prepare(
    `SELECT b.batch_id, b.title, b.description, b.pr_url, b.created_at,
            (SELECT COUNT(*) FROM qa_items i WHERE i.batch_id = b.batch_id) AS item_count
       FROM qa_batches b
      ORDER BY b.created_at DESC
      LIMIT 200`,
  ).all<{
    batch_id: string;
    title: string;
    description: string | null;
    pr_url: string | null;
    created_at: number;
    item_count: number;
  }>();
  return (res.results ?? []).map(asBatch);
}

export async function listQaItems(db: D1Database, batchId: string): Promise<QaItem[]> {
  const res = await db.prepare(
    `SELECT i.item_id, i.batch_id, i.handle, i.run_id, i.share_id, i.chat_id,
            i.status, i.verdict_ok, i.verdict_json, i.created_at,
            CASE WHEN s.bot_handle IS NOT NULL THEN 1 ELSE 0 END AS listed_on_floor
       FROM qa_items i
       LEFT JOIN shared_chats s ON s.share_id = i.share_id
      WHERE i.batch_id = ?1
      ORDER BY i.created_at DESC`,
  ).bind(batchId).all<{
    item_id: string;
    batch_id: string;
    handle: string | null;
    run_id: string | null;
    share_id: string;
    chat_id: string | null;
    status: string;
    listed_on_floor: number | null;
    verdict_ok: number | null;
    verdict_json: string | null;
    created_at: number;
  }>();
  return (res.results ?? []).map(asItem);
}

export async function attachQaItem(
  db: D1Database,
  input: {
    batch_id: string;
    handle?: string | null;
    run_id?: string | null;
    share_id: string;
    chat_id?: string | null;
    status?: string;
  },
  now = Date.now(),
): Promise<QaItem> {
  const existing = await db.prepare(
    `SELECT item_id, batch_id, handle, run_id, share_id, chat_id, status,
            verdict_ok, verdict_json, created_at
       FROM qa_items WHERE share_id = ?1`,
  ).bind(input.share_id).first<{
    item_id: string;
    batch_id: string;
    handle: string | null;
    run_id: string | null;
    share_id: string;
    chat_id: string | null;
    status: string;
    verdict_ok: number | null;
    verdict_json: string | null;
    created_at: number;
  }>();
  if (existing) return asItem({ ...existing, listed_on_floor: 0 });

  const itemId = newQaId();
  const status = input.status ?? "shared";
  await db.prepare(
    `INSERT INTO qa_items
       (item_id, batch_id, handle, run_id, share_id, chat_id, status, verdict_ok, verdict_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8)`,
  ).bind(
    itemId,
    input.batch_id,
    input.handle ?? null,
    input.run_id ?? null,
    input.share_id,
    input.chat_id ?? null,
    status,
    now,
  ).run();
  return {
    item_id: itemId,
    batch_id: input.batch_id,
    handle: input.handle ?? null,
    run_id: input.run_id ?? null,
    share_id: input.share_id,
    chat_id: input.chat_id ?? null,
    status,
    listed_on_floor: false,
    verdict_ok: null,
    verdict_json: null,
    created_at: now,
  };
}

export async function importQaShares(
  db: D1Database,
  batchId: string,
  shareIds: string[],
): Promise<{ items: QaItem[]; missing: string[] }> {
  const items: QaItem[] = [];
  const missing: string[] = [];
  for (const shareId of shareIds) {
    const share = await db.prepare(
      `SELECT share_id, chat_id, run_id, bot_handle
         FROM shared_chats WHERE share_id = ?1`,
    ).bind(shareId).first<{
      share_id: string;
      chat_id: string | null;
      run_id: string | null;
      bot_handle: string | null;
    }>();
    if (!share) {
      missing.push(shareId);
      continue;
    }
    if (share.bot_handle) {
      await clearBotListing(db, share.share_id);
    }
    const item = await attachQaItem(db, {
      batch_id: batchId,
      handle: share.bot_handle,
      run_id: share.run_id,
      share_id: share.share_id,
      chat_id: share.chat_id,
      status: "shared",
    });
    items.push({ ...item, listed_on_floor: false });
  }
  return { items, missing };
}

export async function patchQaItem(
  db: D1Database,
  itemId: string,
  patch: { verdict_ok: boolean | null; verdict_json: string | null },
): Promise<QaItem | null> {
  const existing = await db.prepare(
    `SELECT item_id FROM qa_items WHERE item_id = ?1`,
  ).bind(itemId).first<{ item_id: string }>();
  if (!existing) return null;
  await db.prepare(
    `UPDATE qa_items
        SET verdict_ok = COALESCE(?2, verdict_ok),
            verdict_json = COALESCE(?3, verdict_json)
      WHERE item_id = ?1`,
  ).bind(
    itemId,
    patch.verdict_ok == null ? null : patch.verdict_ok ? 1 : 0,
    patch.verdict_json,
  ).run();
  const row = await db.prepare(
    `SELECT i.item_id, i.batch_id, i.handle, i.run_id, i.share_id, i.chat_id,
            i.status, i.verdict_ok, i.verdict_json, i.created_at,
            CASE WHEN s.bot_handle IS NOT NULL THEN 1 ELSE 0 END AS listed_on_floor
       FROM qa_items i
       LEFT JOIN shared_chats s ON s.share_id = i.share_id
      WHERE i.item_id = ?1`,
  ).bind(itemId).first<{
    item_id: string;
    batch_id: string;
    handle: string | null;
    run_id: string | null;
    share_id: string;
    chat_id: string | null;
    status: string;
    listed_on_floor: number | null;
    verdict_ok: number | null;
    verdict_json: string | null;
    created_at: number;
  }>();
  return row ? asItem(row) : null;
}
