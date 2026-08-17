-- Research brief warm item store (0004).
--
-- Item-scoped state for the `research-briefs-daily` job. Mirrors
-- `symbol_state` / `ohlc_backfill_state` so the universe can be warmed into the
-- API Worker's D1 `ticker_research` cache in small due batches (each pass POSTs
-- a ticker list to POST /api/research/warm). One row per ticker.
--
-- Timestamps are epoch milliseconds (INTEGER). enabled=1 means the symbol
-- participates.

CREATE TABLE IF NOT EXISTS research_brief_state (
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

CREATE INDEX IF NOT EXISTS idx_research_brief_due
  ON research_brief_state (enabled, next_attempt_after);
