import assert from "node:assert/strict";
import test from "node:test";
import {
  POSITION_MARK_SNAP_JOB,
  recordWorkerJobPass,
  getWorkerJobState,
  listWorkerJobPasses,
} from "../src/worker-job-state.ts";
import { getPositionMarkSnapStatus } from "../src/position-mark-snap.ts";

type Stored = Record<string, unknown>;

function mockJobDb() {
  const state = new Map<string, Stored>();
  const passes: Stored[] = [];

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          if (sql.includes("INSERT INTO worker_job_passes")) {
            passes.push({
              id: binds[0],
              job_id: binds[1],
              started_at: binds[2],
              finished_at: binds[3],
              ok: binds[4],
              scanned: binds[5],
              marked: binds[6],
              skipped: binds[7],
              failed: binds[8],
              paper_scanned: binds[9],
              bot_scanned: binds[10],
              duration_ms: binds[11],
              error: binds[12],
              source: binds[13],
            });
          }
          if (sql.includes("INSERT INTO worker_job_state")) {
            state.set(String(binds[0]), {
              job_id: binds[0],
              last_started_at: binds[1],
              last_finished_at: binds[2],
              last_ok: binds[3],
              consecutive_failures: binds[4],
              last_error: binds[5],
              last_scanned: binds[6],
              last_marked: binds[7],
              last_skipped: binds[8],
              last_failed: binds[9],
              last_paper_scanned: binds[10],
              last_bot_scanned: binds[11],
              last_duration_ms: binds[12],
              updated_at: binds[2],
            });
          }
          return { success: true };
        },
        async first<T>() {
          if (sql.includes("FROM worker_job_state")) {
            return (state.get(String(binds[0])) as T) ?? null;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes("FROM worker_job_passes")) {
            const jobId = binds[0];
            const lim = Number(binds[1] ?? 12);
            const list = passes
              .filter((p) => p.job_id === jobId)
              .sort((a, b) => Number(b.started_at) - Number(a.started_at))
              .slice(0, lim);
            return { results: list as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
  };

  return { db: db as unknown as D1Database, state, passes };
}

test("recordWorkerJobPass updates state and resets failures on success", async () => {
  const { db } = mockJobDb();
  await recordWorkerJobPass(db, {
    jobId: POSITION_MARK_SNAP_JOB,
    startedAt: 1000,
    finishedAt: 1500,
    ok: false,
    source: "cron",
    error: "lake timeout",
  });
  let state = await getWorkerJobState(db, POSITION_MARK_SNAP_JOB);
  assert.equal(state?.consecutive_failures, 1);
  assert.equal(state?.last_ok, 0);
  assert.equal(state?.last_error, "lake timeout");

  await recordWorkerJobPass(db, {
    jobId: POSITION_MARK_SNAP_JOB,
    startedAt: 2000,
    finishedAt: 2200,
    ok: true,
    source: "admin",
    scanned: 4,
    marked: 3,
    skipped: 1,
    failed: 0,
    paperScanned: 2,
    botScanned: 2,
  });
  state = await getWorkerJobState(db, POSITION_MARK_SNAP_JOB);
  assert.equal(state?.consecutive_failures, 0);
  assert.equal(state?.last_ok, 1);
  assert.equal(state?.last_marked, 3);
  assert.equal(state?.last_duration_ms, 200);
  assert.equal(state?.last_error, null);

  const recent = await listWorkerJobPasses(db, POSITION_MARK_SNAP_JOB, 5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.source, "admin");
  assert.equal(recent[1]!.ok, 0);
});

test("getPositionMarkSnapStatus rolls up open book freshness", async () => {
  const now = Date.UTC(2026, 7, 23, 18, 0, 0);
  const stale = now - 3 * 60 * 60 * 1000;

  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          return { success: true };
        },
        async first<T>() {
          if (sql.includes("FROM paper_positions")) {
            return {
              open_count: 2,
              never_marked: 1,
              stale_open: 1,
              oldest_marked_at: stale,
              newest_marked_at: now,
            } as T;
          }
          if (sql.includes("FROM bot_trade_positions")) {
            return {
              open_count: 3,
              never_marked: 0,
              stale_open: 0,
              oldest_marked_at: now,
              newest_marked_at: now,
            } as T;
          }
          if (sql.includes("FROM worker_job_state")) {
            return {
              job_id: POSITION_MARK_SNAP_JOB,
              last_started_at: now - 1000,
              last_finished_at: now,
              last_ok: 1,
              consecutive_failures: 0,
              last_error: null,
              last_scanned: 5,
              last_marked: 5,
              last_skipped: 0,
              last_failed: 0,
              last_paper_scanned: 2,
              last_bot_scanned: 3,
              last_duration_ms: 1000,
              updated_at: now,
            } as T;
          }
          return null;
        },
        async all<T>() {
          if (sql.includes("FROM worker_job_passes")) {
            return {
              results: [{
                id: "wjp_1",
                job_id: POSITION_MARK_SNAP_JOB,
                started_at: now - 1000,
                finished_at: now,
                ok: 1,
                scanned: 5,
                marked: 5,
                skipped: 0,
                failed: 0,
                paper_scanned: 2,
                bot_scanned: 3,
                duration_ms: 1000,
                error: null,
                source: "cron",
              }] as T[],
            };
          }
          return { results: [] as T[] };
        },
      };
      void binds;
      return stmt;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;

  const status = await getPositionMarkSnapStatus(db, { now });
  assert.equal(status.job_id, POSITION_MARK_SNAP_JOB);
  assert.equal(status.books.open_total, 5);
  assert.equal(status.books.paper_open, 2);
  assert.equal(status.books.bot_open, 3);
  assert.equal(status.books.stale_open, 1);
  assert.equal(status.books.never_marked, 1);
  assert.equal(status.state?.last_marked, 5);
  assert.equal(status.recent_passes.length, 1);
});
