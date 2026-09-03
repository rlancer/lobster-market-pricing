-- Paper portfolio + tracked trade ideas.
--
-- Suggested trades from Chat are ephemeral (tool events ~30d). When a
-- signed-in user tracks an idea, we snapshot the structure into
-- paper_positions with lake entry marks and keep marking for PnL. One paper
-- cash account per user (auto-created on first track). User state lives in
-- SCHEMA_DB — never in the Iceberg lake.

CREATE TABLE IF NOT EXISTS paper_accounts (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  cash_cents INTEGER NOT NULL,
  starting_cash_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  chat_id TEXT,
  suggestion_key TEXT,
  ticker TEXT NOT NULL,
  bias TEXT,
  conviction TEXT,
  structure TEXT NOT NULL,
  rationale TEXT,
  liquidity TEXT,
  legs_json TEXT NOT NULL,
  qty INTEGER NOT NULL,
  entry_value REAL,
  entry_marked_at INTEGER,
  mark_value REAL,
  marked_at INTEGER,
  realized_pnl REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_user_opened
  ON paper_positions(user_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_paper_positions_user_status
  ON paper_positions(user_id, status, opened_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_positions_suggestion
  ON paper_positions(user_id, suggestion_key)
  WHERE suggestion_key IS NOT NULL;
