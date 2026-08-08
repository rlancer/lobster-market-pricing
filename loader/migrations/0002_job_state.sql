-- ETL scheduler job-state ledger (0002).
--
-- One row per registered ETL job (Phase 1: exactly `cboe-options`). This is the
-- *schedule ledger*: it holds the job's policy (enabled, cadence, market-gate
-- flag) plus a job-level progress ledger (last success, consecutive failures,
-- backoff, last error). It complements, not replaces, the existing item stores
-- (symbol_state stays the per-symbol item store for the CBOE job).
--
-- Timestamps are epoch milliseconds (INTEGER). enabled=1 means the job
-- participates in the scheduler loop. market_gated=1 means the job's pass is
-- skipped while the US regular session is closed. cadence_seconds is the
-- nominal reload cadence (item-scoped jobs like cboe-options track per-item
-- scheduling in their item store; the job row reflects the sweep cadence).

CREATE TABLE IF NOT EXISTS job_state (
  job_id               TEXT PRIMARY KEY,
  handler              TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1,
  cadence_seconds      INTEGER NOT NULL,
  market_gated         INTEGER NOT NULL DEFAULT 0,
  next_attempt_after   INTEGER NOT NULL DEFAULT 0,
  last_success_at      INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_seconds      INTEGER NOT NULL DEFAULT 60,
  last_error           TEXT
);

-- Serve the "pick due jobs" scan so each scheduler pass reads only the rows
-- that are actually due rather than the whole ledger.
CREATE INDEX IF NOT EXISTS idx_job_state_due
  ON job_state (enabled, next_attempt_after);
