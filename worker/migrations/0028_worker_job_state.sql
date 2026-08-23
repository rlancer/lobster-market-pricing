-- Durable ledger for Worker cron / admin-triggered jobs (mark snaps, …).
-- Mirrors loader job_state lightly so /monitor can show last pass + failures
-- without scraping Cloudflare logs.

CREATE TABLE IF NOT EXISTS worker_job_state (
  job_id TEXT PRIMARY KEY NOT NULL,
  last_started_at INTEGER,
  last_finished_at INTEGER,
  last_ok INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_scanned INTEGER,
  last_marked INTEGER,
  last_skipped INTEGER,
  last_failed INTEGER,
  last_paper_scanned INTEGER,
  last_bot_scanned INTEGER,
  last_duration_ms INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_job_passes (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  scanned INTEGER,
  marked INTEGER,
  skipped INTEGER,
  failed INTEGER,
  paper_scanned INTEGER,
  bot_scanned INTEGER,
  duration_ms INTEGER,
  error TEXT,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_job_passes_job
  ON worker_job_passes(job_id, started_at DESC);
