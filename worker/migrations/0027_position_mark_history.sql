-- Durable daily mark history for paper + bot books.
--
-- Positions only keep the latest mark_value. Without a history table (and a
-- cron that snaps open books), day-over-day PnL cannot be reconstructed once
-- marks move. One row per (book, position, America/New_York calendar day);
-- later marks the same day upsert so the series stays daily, not hourly.

CREATE TABLE IF NOT EXISTS position_mark_history (
  id TEXT PRIMARY KEY NOT NULL,
  book TEXT NOT NULL,
  position_id TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  entry_value REAL,
  mark_value REAL NOT NULL,
  unrealized_pnl REAL,
  legs_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_position_mark_history_day
  ON position_mark_history(book, position_id, as_of_date);

CREATE INDEX IF NOT EXISTS idx_position_mark_history_position
  ON position_mark_history(book, position_id, as_of_date DESC);

CREATE INDEX IF NOT EXISTS idx_position_mark_history_as_of
  ON position_mark_history(as_of_date, book);
