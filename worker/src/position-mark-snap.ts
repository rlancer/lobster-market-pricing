/**
 * Scheduled remake of open paper + bot positions into daily mark history.
 *
 * Live portfolio reads still refresh marks; this cron makes history durable
 * even when nobody opens the book.
 */

import type { TradeLeg } from "./copilot-trades";
import { markStructure, type LakeSql, type StructureMark } from "./paper-portfolio";
import { recordDailyMarkSafe, type MarkBook } from "./position-mark-history";

export interface OpenMarkTarget {
  book: MarkBook;
  id: string;
  ticker: string;
  qty: number;
  legs_json: string;
  entry_value: number | null;
  entry_marked_at: number | null;
}

export interface SnapOpenMarksSummary {
  scanned: number;
  marked: number;
  skipped: number;
  failed: number;
  paper_scanned: number;
  bot_scanned: number;
}

function parseLegsJson(raw: string): TradeLeg[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TradeLeg[];
  } catch {
    return [];
  }
}

function legsMarkJson(mark: StructureMark): string {
  return JSON.stringify(mark.legs);
}

/** Oldest-marked open rows first so stale books catch up under a per-tick cap. */
export async function loadOpenMarkTargets(
  db: D1Database,
  limit: number,
): Promise<OpenMarkTarget[]> {
  const half = Math.max(1, Math.floor(limit / 2));
  const paper = await db.prepare(
    `SELECT id, ticker, qty, legs_json, entry_value, entry_marked_at
     FROM paper_positions
     WHERE status = 'open'
     ORDER BY (marked_at IS NULL) DESC, marked_at ASC, opened_at ASC
     LIMIT ?1`,
  ).bind(half).all<Omit<OpenMarkTarget, "book">>();

  const bot = await db.prepare(
    `SELECT id, ticker, qty, legs_json, entry_value, entry_marked_at
     FROM bot_trade_positions
     WHERE status = 'open'
     ORDER BY (marked_at IS NULL) DESC, marked_at ASC, opened_at ASC
     LIMIT ?1`,
  ).bind(limit - half).all<Omit<OpenMarkTarget, "book">>();

  const out: OpenMarkTarget[] = [];
  for (const row of paper.results ?? []) {
    out.push({ book: "paper", ...row });
  }
  for (const row of bot.results ?? []) {
    out.push({ book: "bot", ...row });
  }
  return out;
}

async function applyOpenMark(
  db: D1Database,
  lake: LakeSql,
  target: OpenMarkTarget,
  now: number,
): Promise<"marked" | "skipped" | "failed"> {
  const legs = parseLegsJson(target.legs_json);
  if (!legs.length) return "skipped";

  let mark: StructureMark;
  try {
    mark = await markStructure(lake, target.ticker, legs, target.qty, now);
  } catch {
    return "failed";
  }
  if (mark.value == null) return "skipped";

  const entryValue = target.entry_value ?? mark.value;

  if (target.book === "paper") {
    await db.prepare(
      `UPDATE paper_positions
       SET mark_value = ?1, marked_at = ?2,
           entry_value = COALESCE(entry_value, ?1),
           entry_marked_at = COALESCE(entry_marked_at, ?2)
       WHERE id = ?3 AND status = 'open'`,
    ).bind(mark.value, now, target.id).run();
  } else {
    await db.prepare(
      `UPDATE bot_trade_positions
       SET mark_value = ?1, marked_at = ?2,
           entry_value = COALESCE(entry_value, ?1),
           entry_marked_at = COALESCE(entry_marked_at, ?2)
       WHERE id = ?3 AND status = 'open'`,
    ).bind(mark.value, now, target.id).run();
  }

  await recordDailyMarkSafe(db, {
    book: target.book,
    positionId: target.id,
    markValue: mark.value,
    entryValue,
    markedAt: now,
    source: "cron",
    legsJson: legsMarkJson(mark),
  });

  return "marked";
}

/**
 * Remake open positions and upsert today's history row.
 * Cap keeps Worker cron under lake/CPU budget; next hour continues the queue.
 */
export async function snapOpenPositionMarks(
  db: D1Database,
  lake: LakeSql,
  opts?: { limit?: number; now?: number },
): Promise<SnapOpenMarksSummary> {
  const now = opts?.now ?? Date.now();
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);
  const targets = await loadOpenMarkTargets(db, limit);

  let marked = 0;
  let skipped = 0;
  let failed = 0;
  let paperScanned = 0;
  let botScanned = 0;

  for (const target of targets) {
    if (target.book === "paper") paperScanned += 1;
    else botScanned += 1;
    const result = await applyOpenMark(db, lake, target, now);
    if (result === "marked") marked += 1;
    else if (result === "skipped") skipped += 1;
    else failed += 1;
  }

  return {
    scanned: targets.length,
    marked,
    skipped,
    failed,
    paper_scanned: paperScanned,
    bot_scanned: botScanned,
  };
}
