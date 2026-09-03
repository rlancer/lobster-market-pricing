-- On-demand symbol enrollment (0005).
--
-- Tickers requested outside the bundled symbols/universe.json manifest
-- (Chat / research / admin) land here so ETL keeps refreshing them forever
-- without a git deploy. The scheduler unions this table with the bundled
-- manifest for cboe-options, ohlc-daily, ohlc-backfill, earnings, fundamentals,
-- and research-briefs.
--
-- Timestamps are epoch milliseconds (INTEGER). enabled=1 means the symbol
-- participates in the effective universe.

CREATE TABLE IF NOT EXISTS enrolled_symbols (
  symbol              TEXT PRIMARY KEY,
  source              TEXT NOT NULL DEFAULT 'on_demand',
  requested_by        TEXT,
  requested_at        INTEGER NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_error          TEXT,
  notes               TEXT
);

CREATE INDEX IF NOT EXISTS idx_enrolled_symbols_enabled
  ON enrolled_symbols (enabled);
