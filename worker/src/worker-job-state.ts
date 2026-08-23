/**
 * Worker cron / admin job ledger — last pass + recent history for /monitor.
 */

export const POSITION_MARK_SNAP_JOB = "position-mark-snap";

export interface WorkerJobStateRow {
  job_id: string;
  last_started_at: number | null;
  last_finished_at: number | null;
  last_ok: number | null;
  consecutive_failures: number;
  last_error: string | null;
  last_scanned: number | null;
  last_marked: number | null;
  last_skipped: number | null;
  last_failed: number | null;
  last_paper_scanned: number | null;
  last_bot_scanned: number | null;
  last_duration_ms: number | null;
  updated_at: number;
}

export interface WorkerJobPassRow {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number;
  ok: number;
  scanned: number | null;
  marked: number | null;
  skipped: number | null;
  failed: number | null;
  paper_scanned: number | null;
  bot_scanned: number | null;
  duration_ms: number | null;
  error: string | null;
  source: string;
}

export type JobPassSource = "cron" | "admin";

export interface RecordJobPassInput {
  jobId: string;
  startedAt: number;
  finishedAt?: number;
  ok: boolean;
  source: JobPassSource;
  scanned?: number;
  marked?: number;
  skipped?: number;
  failed?: number;
  paperScanned?: number;
  botScanned?: number;
  error?: string | null;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `${prefix}_${out}`;
}

export async function recordWorkerJobPass(
  db: D1Database,
  input: RecordJobPassInput,
): Promise<WorkerJobPassRow> {
  const finishedAt = input.finishedAt ?? Date.now();
  const durationMs = Math.max(0, finishedAt - input.startedAt);
  const id = newId("wjp");
  const ok = input.ok ? 1 : 0;
  const error = input.error?.trim() ? input.error.trim().slice(0, 480) : null;

  const existing = await db.prepare(
    `SELECT consecutive_failures FROM worker_job_state WHERE job_id = ?1`,
  ).bind(input.jobId).first<{ consecutive_failures: number }>();
  const failures = input.ok ? 0 : (existing?.consecutive_failures ?? 0) + 1;

  await db.batch([
    db.prepare(
      `INSERT INTO worker_job_passes (
         id, job_id, started_at, finished_at, ok,
         scanned, marked, skipped, failed,
         paper_scanned, bot_scanned, duration_ms, error, source
       ) VALUES (
         ?1, ?2, ?3, ?4, ?5,
         ?6, ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14
       )`,
    ).bind(
      id,
      input.jobId,
      input.startedAt,
      finishedAt,
      ok,
      input.scanned ?? null,
      input.marked ?? null,
      input.skipped ?? null,
      input.failed ?? null,
      input.paperScanned ?? null,
      input.botScanned ?? null,
      durationMs,
      error,
      input.source,
    ),
    db.prepare(
      `INSERT INTO worker_job_state (
         job_id, last_started_at, last_finished_at, last_ok,
         consecutive_failures, last_error,
         last_scanned, last_marked, last_skipped, last_failed,
         last_paper_scanned, last_bot_scanned, last_duration_ms, updated_at
       ) VALUES (
         ?1, ?2, ?3, ?4,
         ?5, ?6,
         ?7, ?8, ?9, ?10,
         ?11, ?12, ?13, ?3
       )
       ON CONFLICT(job_id) DO UPDATE SET
         last_started_at = excluded.last_started_at,
         last_finished_at = excluded.last_finished_at,
         last_ok = excluded.last_ok,
         consecutive_failures = excluded.consecutive_failures,
         last_error = excluded.last_error,
         last_scanned = excluded.last_scanned,
         last_marked = excluded.last_marked,
         last_skipped = excluded.last_skipped,
         last_failed = excluded.last_failed,
         last_paper_scanned = excluded.last_paper_scanned,
         last_bot_scanned = excluded.last_bot_scanned,
         last_duration_ms = excluded.last_duration_ms,
         updated_at = excluded.updated_at`,
    ).bind(
      input.jobId,
      input.startedAt,
      finishedAt,
      ok,
      failures,
      error,
      input.scanned ?? null,
      input.marked ?? null,
      input.skipped ?? null,
      input.failed ?? null,
      input.paperScanned ?? null,
      input.botScanned ?? null,
      durationMs,
    ),
  ]);

  // Keep history bounded (best-effort).
  try {
    await db.prepare(
      `DELETE FROM worker_job_passes
       WHERE job_id = ?1
         AND started_at < COALESCE((
           SELECT MIN(started_at) FROM (
             SELECT started_at FROM worker_job_passes
             WHERE job_id = ?1
             ORDER BY started_at DESC
             LIMIT 50
           )
         ), 0)`,
    ).bind(input.jobId).run();
  } catch {
    // Ignore prune failures — status still has worker_job_state.
  }

  return {
    id,
    job_id: input.jobId,
    started_at: input.startedAt,
    finished_at: finishedAt,
    ok,
    scanned: input.scanned ?? null,
    marked: input.marked ?? null,
    skipped: input.skipped ?? null,
    failed: input.failed ?? null,
    paper_scanned: input.paperScanned ?? null,
    bot_scanned: input.botScanned ?? null,
    duration_ms: durationMs,
    error,
    source: input.source,
  };
}

export async function getWorkerJobState(
  db: D1Database,
  jobId: string,
): Promise<WorkerJobStateRow | null> {
  return db.prepare(
    `SELECT * FROM worker_job_state WHERE job_id = ?1`,
  ).bind(jobId).first<WorkerJobStateRow>();
}

export async function listWorkerJobPasses(
  db: D1Database,
  jobId: string,
  limit = 12,
): Promise<WorkerJobPassRow[]> {
  const lim = Math.min(Math.max(limit, 1), 50);
  const rows = await db.prepare(
    `SELECT * FROM worker_job_passes
     WHERE job_id = ?1
     ORDER BY started_at DESC
     LIMIT ?2`,
  ).bind(jobId, lim).all<WorkerJobPassRow>();
  return rows.results ?? [];
}
