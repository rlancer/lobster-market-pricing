-- OHLC backfill item store (0003).
--
-- Item-scoped state for the `ohlc-backfill` job, mirroring `symbol_state` so
-- the 2y S&P 500 backfill is resumable per-symbol (unauth Yahoo throttles, so
-- a long run must be able to resume from where it left off). One row per
-- ticker. `security_id` is the stable identity used by the corporate-actions
-- and symbol_history paths.
--
-- Timestamps are epoch milliseconds (INTEGER). enabled=1 means the symbol
-- participates. period1/period2 are the epoch-second window the item was last
-- fetched over (informational; the job recomputes the window from the current
-- date each pass).

CREATE TABLE IF NOT EXISTS ohlc_backfill_state (
  symbol              TEXT PRIMARY KEY,
  security_id         TEXT,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_success_at     INTEGER,
  last_attempt_at     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_after  INTEGER NOT NULL DEFAULT 0,
  backoff_seconds     INTEGER NOT NULL DEFAULT 60,
  last_error          TEXT,
  priority            INTEGER NOT NULL DEFAULT 0
);

-- Serve the "pick due symbols" scan (small, indexed).
CREATE INDEX IF NOT EXISTS idx_ohlc_backfill_due
  ON ohlc_backfill_state (enabled, next_attempt_after);
