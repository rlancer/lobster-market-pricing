-- Bot suggested-trade performance book (separate from user paper cash).
--
-- Headless bots never claim user_chats, so personal paper auto-track skips them.
-- This table snapshots suggest_trades for bot_handle + lake marks for public PnL
-- on /u/{handle}. No cash account — ideas only.

CREATE TABLE IF NOT EXISTS bot_trade_positions (
  id TEXT PRIMARY KEY NOT NULL,
  bot_handle TEXT NOT NULL,
  status TEXT NOT NULL,
  chat_id TEXT,
  share_id TEXT,
  run_id TEXT,
  suggestion_key TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_bot_trades_handle_opened
  ON bot_trade_positions(bot_handle, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_trades_handle_status
  ON bot_trade_positions(bot_handle, status, opened_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_trades_suggestion
  ON bot_trade_positions(bot_handle, suggestion_key);

CREATE INDEX IF NOT EXISTS idx_bot_trades_chat
  ON bot_trade_positions(chat_id);
