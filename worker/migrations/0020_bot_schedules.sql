-- Bot chat schedules (0020).
--
-- Enables server-side recurring Copilot runs (e.g. @nowlobster hourly market
-- overview during US session). Cron on the API Worker picks due rows; market
-- gated schedules sleep while the market is closed.

CREATE TABLE IF NOT EXISTS bot_schedules (
  handle                TEXT PRIMARY KEY,
  enabled               INTEGER NOT NULL DEFAULT 1,
  cadence_seconds       INTEGER NOT NULL DEFAULT 3600,
  market_gated          INTEGER NOT NULL DEFAULT 1,
  prompt                TEXT NOT NULL,
  next_run_at           INTEGER NOT NULL,
  last_run_at           INTEGER,
  last_run_id           TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (handle) REFERENCES bot_profiles(handle)
);

CREATE INDEX IF NOT EXISTS idx_bot_schedules_due
  ON bot_schedules(enabled, next_run_at);

-- Hourly desk overview for @nowlobster (seeded in 0019). next_run_at = 0 so
-- the next cron after market open picks it up immediately.
INSERT OR IGNORE INTO bot_schedules (
  handle,
  enabled,
  cadence_seconds,
  market_gated,
  prompt,
  next_run_at,
  last_run_at,
  last_run_id,
  consecutive_failures,
  last_error,
  created_at,
  updated_at
) VALUES (
  'nowlobster',
  1,
  3600,
  1,
  'Hourly market overview: what''s happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.',
  0,
  NULL,
  NULL,
  0,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
