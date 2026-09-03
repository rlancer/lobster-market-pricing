-- Personal account bots (0032).
--
-- Signed-in users can schedule private Copilot runs (e.g. hourly portfolio
-- risk during US market hours). These are NOT public personas: they do not
-- claim a /u/{handle}, do not appear on GET /api/bots, and do not stamp
-- shared_chats.bot_handle. Timeline publish is opt-in (default off).

CREATE TABLE IF NOT EXISTS user_bots (
  bot_id                TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  name                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,
  schedule_preset       TEXT NOT NULL,
  cadence_seconds       INTEGER NOT NULL,
  market_gated          INTEGER NOT NULL DEFAULT 1,
  attach_portfolio      INTEGER NOT NULL DEFAULT 1,
  publish_to_timeline   INTEGER NOT NULL DEFAULT 0,
  email_alerts          INTEGER NOT NULL DEFAULT 1,
  enabled               INTEGER NOT NULL DEFAULT 1,
  next_run_at           INTEGER NOT NULL,
  last_run_at           INTEGER,
  last_run_id           TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_bots_user
  ON user_bots(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_bots_due
  ON user_bots(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS user_bot_runs (
  run_id     TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  share_id   TEXT,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (bot_id) REFERENCES user_bots(bot_id)
);

CREATE INDEX IF NOT EXISTS idx_user_bot_runs_bot
  ON user_bot_runs(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_bot_runs_status
  ON user_bot_runs(status, updated_at DESC);
