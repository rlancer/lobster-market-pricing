/**
 * Durable daily position marks for paper + bot books.
 *
 * Latest mark on the position row is for live MTM; this table keeps one snap
 * per America/New_York calendar day so daily / path PnL survives unread books.
 */

import { etWall } from "./market-hours";

export type MarkBook = "paper" | "bot";
export type MarkSource = "entry" | "refresh" | "cron" | "close";

export interface PositionMarkRow {
  id: string;
  book: MarkBook;
  position_id: string;
  as_of_date: string;
  marked_at: number;
  source: MarkSource;
  entry_value: number | null;
  mark_value: number;
  unrealized_pnl: number | null;
  legs_json: string | null;
  created_at: number;
}

export interface PositionMarkView {
  as_of_date: string;
  marked_at: number;
  marked_at_iso: string;
  source: MarkSource;
  entry_value: number | null;
  mark_value: number;
  unrealized_pnl: number | null;
  /** Day-over-day change in mark (null on first snap). */
  daily_pnl: number | null;
  legs: unknown[] | null;
}

export interface UpsertDailyMarkInput {
  book: MarkBook;
  positionId: string;
  markValue: number;
  entryValue: number | null;
  markedAt?: number;
  source: MarkSource;
  /** Serialized LegMark[] (or null when unavailable). */
  legsJson?: string | null;
}

function unrealized(entryValue: number | null, markValue: number | null): number | null {
  if (entryValue == null || markValue == null) return null;
  return markValue - entryValue;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `${prefix}_${out}`;
}

/** America/New_York calendar date (YYYY-MM-DD) for market-day PnL series. */
export function asOfDateEt(ms: number): string {
  const w = etWall(ms);
  const y = w.getUTCFullYear();
  const m = String(w.getUTCMonth() + 1).padStart(2, "0");
  const d = String(w.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Upsert today's daily mark for a position. Same-day refreshes / cron ticks
 * overwrite so storage stays one row per trading calendar day.
 */
export async function upsertDailyMark(
  db: D1Database,
  input: UpsertDailyMarkInput,
): Promise<PositionMarkRow> {
  const now = input.markedAt ?? Date.now();
  const asOf = asOfDateEt(now);
  const pnl = unrealized(input.entryValue, input.markValue);
  const id = newId("pmh");
  const legsJson = input.legsJson ?? null;

  await db.prepare(
    `INSERT INTO position_mark_history (
       id, book, position_id, as_of_date, marked_at, source,
       entry_value, mark_value, unrealized_pnl, legs_json, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?5)
     ON CONFLICT(book, position_id, as_of_date) DO UPDATE SET
       marked_at = excluded.marked_at,
       source = excluded.source,
       entry_value = excluded.entry_value,
       mark_value = excluded.mark_value,
       unrealized_pnl = excluded.unrealized_pnl,
       legs_json = COALESCE(excluded.legs_json, position_mark_history.legs_json)`,
  ).bind(
    id,
    input.book,
    input.positionId,
    asOf,
    now,
    input.source,
    input.entryValue,
    input.markValue,
    pnl,
    legsJson,
  ).run();

  const row = await db.prepare(
    `SELECT * FROM position_mark_history
     WHERE book = ?1 AND position_id = ?2 AND as_of_date = ?3`,
  ).bind(input.book, input.positionId, asOf).first<PositionMarkRow>();
  if (!row) {
    return {
      id,
      book: input.book,
      position_id: input.positionId,
      as_of_date: asOf,
      marked_at: now,
      source: input.source,
      entry_value: input.entryValue,
      mark_value: input.markValue,
      unrealized_pnl: pnl,
      legs_json: legsJson,
      created_at: now,
    };
  }
  return row;
}

/** Best-effort history write — never fail the live mark path on history errors. */
export async function recordDailyMarkSafe(
  db: D1Database,
  input: UpsertDailyMarkInput,
): Promise<void> {
  try {
    await upsertDailyMark(db, input);
  } catch (error) {
    console.warn("position mark history write failed", error);
  }
}

export function dailyPnlFromMarks(
  marks: Array<{ mark_value: number }>,
): Array<number | null> {
  return marks.map((m, i) => {
    if (i === 0) return null;
    const prev = marks[i - 1]!.mark_value;
    return m.mark_value - prev;
  });
}

function parseLegs(raw: string | null): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function listPositionMarkHistory(
  db: D1Database,
  book: MarkBook,
  positionId: string,
  opts?: { limit?: number },
): Promise<PositionMarkView[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 90, 1), 366);
  const rows = await db.prepare(
    `SELECT * FROM position_mark_history
     WHERE book = ?1 AND position_id = ?2
     ORDER BY as_of_date ASC
     LIMIT ?3`,
  ).bind(book, positionId, limit).all<PositionMarkRow>();

  const list = rows.results ?? [];
  const daily = dailyPnlFromMarks(list);
  return list.map((row, i) => ({
    as_of_date: row.as_of_date,
    marked_at: row.marked_at,
    marked_at_iso: new Date(row.marked_at).toISOString(),
    source: row.source,
    entry_value: row.entry_value,
    mark_value: row.mark_value,
    unrealized_pnl: row.unrealized_pnl,
    daily_pnl: daily[i] ?? null,
    legs: parseLegs(row.legs_json),
  }));
}
