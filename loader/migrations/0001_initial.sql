-- Continuous loader D1 state schema (0001).
-- Per-symbol management for the CBOE refresh loop. Timestamps are epoch
-- milliseconds (INTEGER). enabled=1 means the symbol participates in the loop.

CREATE TABLE IF NOT EXISTS symbol_state (
  symbol              TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_success_at     INTEGER,
  last_attempt_at     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_after  INTEGER NOT NULL DEFAULT 0,
  backoff_seconds     INTEGER NOT NULL DEFAULT 60,
  last_error          TEXT,
  priority            INTEGER NOT NULL DEFAULT 0
);

-- Serve the "pick due symbols" scan (small, indexed) so each loop pass reads
-- only the few rows that are actually due rather than the whole table.
CREATE INDEX IF NOT EXISTS idx_symbol_state_due
  ON symbol_state (enabled, next_attempt_after);

-- Small key/value store for observable loop stats (e.g. the last pass summary)
-- surfaced by /loop/status.
CREATE TABLE IF NOT EXISTS loader_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
