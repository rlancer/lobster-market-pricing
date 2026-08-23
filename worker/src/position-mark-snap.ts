/**
 * Scheduled remake of open paper + bot positions into daily mark history.
 *
 * Live portfolio reads still refresh marks; this cron makes history durable
 * even when nobody opens the book. Passes are recorded in worker_job_state
 * for the admin Dataset monitor.
 */

import type { TradeLeg } from "./copilot-trades";
import { markStructure, type LakeSql, type StructureMark } from "./paper-portfolio";
import { recordDailyMarkSafe, type MarkBook } from "./position-mark-history";
import {
  getWorkerJobState,
  listWorkerJobPasses,
  POSITION_MARK_SNAP_JOB,
  recordWorkerJobPass,
  type JobPassSource,
  type WorkerJobPassRow,
  type WorkerJobStateRow,
} from "./worker-job-state";

/** Marks older than this count as stale on the monitor (hourly cron + slack). */
export const MARK_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

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
  duration_ms?: number;
  started_at?: number;
  finished_at?: number;
  source?: JobPassSource;
}

export interface PositionMarkBookHealth {
  paper_open: number;
  bot_open: number;
  open_total: number;
  stale_open: number;
  never_marked: number;
  oldest_marked_at: number | null;
  newest_marked_at: number | null;
}

export interface PositionMarkSnapStatus {
  ok: true;
  job_id: typeof POSITION_MARK_SNAP_JOB;
  cron: string;
  stale_after_ms: number;
  state: WorkerJobStateRow | null;
  books: PositionMarkBookHealth;
  recent_passes: WorkerJobPassRow[];
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
 * Records a worker_job_state pass for the Dataset monitor.
 */
export async function snapOpenPositionMarks(
  db: D1Database,
  lake: LakeSql,
  opts?: { limit?: number; now?: number; source?: JobPassSource; recordPass?: boolean },
): Promise<SnapOpenMarksSummary> {
  const startedAt = opts?.now ?? Date.now();
  const source = opts?.source ?? "cron";
  const recordPass = opts?.recordPass !== false;
  const limit = Math.min(Math.max(opts?.limit ?? 80, 1), 200);

  try {
    const targets = await loadOpenMarkTargets(db, limit);

    let marked = 0;
    let skipped = 0;
    let failed = 0;
    let paperScanned = 0;
    let botScanned = 0;

    for (const target of targets) {
      if (target.book === "paper") paperScanned += 1;
      else botScanned += 1;
      const result = await applyOpenMark(db, lake, target, startedAt);
      if (result === "marked") marked += 1;
      else if (result === "skipped") skipped += 1;
      else failed += 1;
    }

    const finishedAt = Date.now();
    const summary: SnapOpenMarksSummary = {
      scanned: targets.length,
      marked,
      skipped,
      failed,
      paper_scanned: paperScanned,
      bot_scanned: botScanned,
      duration_ms: Math.max(0, finishedAt - startedAt),
      started_at: startedAt,
      finished_at: finishedAt,
      source,
    };

    if (recordPass) {
      await recordWorkerJobPass(db, {
        jobId: POSITION_MARK_SNAP_JOB,
        startedAt,
        finishedAt,
        ok: true,
        source,
        scanned: summary.scanned,
        marked: summary.marked,
        skipped: summary.skipped,
        failed: summary.failed,
        paperScanned: summary.paper_scanned,
        botScanned: summary.bot_scanned,
      });
    }

    return summary;
  } catch (error) {
    const finishedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    if (recordPass) {
      try {
        await recordWorkerJobPass(db, {
          jobId: POSITION_MARK_SNAP_JOB,
          startedAt,
          finishedAt,
          ok: false,
          source,
          error: message,
        });
      } catch {
        // Don't mask the original snap failure.
      }
    }
    throw error;
  }
}

async function countOpenBook(
  db: D1Database,
  table: "paper_positions" | "bot_trade_positions",
  staleBefore: number,
): Promise<{ open: number; stale: number; never: number; oldest: number | null; newest: number | null }> {
  const row = await db.prepare(
    `SELECT
       COUNT(*) AS open_count,
       SUM(CASE WHEN marked_at IS NULL THEN 1 ELSE 0 END) AS never_marked,
       SUM(CASE WHEN marked_at IS NOT NULL AND marked_at < ?1 THEN 1 ELSE 0 END) AS stale_open,
       MIN(marked_at) AS oldest_marked_at,
       MAX(marked_at) AS newest_marked_at
     FROM ${table}
     WHERE status = 'open'`,
  ).bind(staleBefore).first<{
    open_count: number;
    never_marked: number;
    stale_open: number;
    oldest_marked_at: number | null;
    newest_marked_at: number | null;
  }>();

  return {
    open: Number(row?.open_count ?? 0),
    stale: Number(row?.stale_open ?? 0),
    never: Number(row?.never_marked ?? 0),
    oldest: row?.oldest_marked_at ?? null,
    newest: row?.newest_marked_at ?? null,
  };
}

/** Admin / monitor snapshot for the hourly mark-snap job. */
export async function getPositionMarkSnapStatus(
  db: D1Database,
  opts?: { now?: number; recentLimit?: number },
): Promise<PositionMarkSnapStatus> {
  const now = opts?.now ?? Date.now();
  const staleBefore = now - MARK_STALE_AFTER_MS;
  const [paper, bot, state, recent] = await Promise.all([
    countOpenBook(db, "paper_positions", staleBefore),
    countOpenBook(db, "bot_trade_positions", staleBefore),
    getWorkerJobState(db, POSITION_MARK_SNAP_JOB),
    listWorkerJobPasses(db, POSITION_MARK_SNAP_JOB, opts?.recentLimit ?? 12),
  ]);

  const oldestCandidates = [paper.oldest, bot.oldest].filter((v): v is number => v != null);
  const newestCandidates = [paper.newest, bot.newest].filter((v): v is number => v != null);

  return {
    ok: true,
    job_id: POSITION_MARK_SNAP_JOB,
    cron: "5 * * * *",
    stale_after_ms: MARK_STALE_AFTER_MS,
    state,
    books: {
      paper_open: paper.open,
      bot_open: bot.open,
      open_total: paper.open + bot.open,
      stale_open: paper.stale + bot.stale,
      never_marked: paper.never + bot.never,
      oldest_marked_at: oldestCandidates.length ? Math.min(...oldestCandidates) : null,
      newest_marked_at: newestCandidates.length ? Math.max(...newestCandidates) : null,
    },
    recent_passes: recent,
  };
}
