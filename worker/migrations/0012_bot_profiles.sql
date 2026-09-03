-- Bot profiles (0012).
--
-- Admin-editable Chat personas that post public chats under a handle
-- (e.g. yololobster = high risk / high reward). Handles share the /u/{handle}
-- URL space with user_profiles — claim checks both tables. Bot shares stamp
-- shared_chats.bot_handle and appear on the public timeline automatically
-- (no share_owners / timeline_posts row required).

CREATE TABLE IF NOT EXISTS bot_profiles (
  handle              TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  persona             TEXT NOT NULL,   -- short label, e.g. "High risk, high reward"
  bio                 TEXT,           -- optional /u page blurb
  system_prompt_extra TEXT NOT NULL DEFAULT '',
  seed_prompts        TEXT NOT NULL DEFAULT '[]',  -- JSON string array
  model               TEXT,           -- optional COPILOT_MODEL override
  reasoning_effort    TEXT,           -- optional COPILOT_REASONING_EFFORT override
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_runs (
  run_id     TEXT PRIMARY KEY,
  handle     TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  share_id   TEXT,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL,  -- queued | running | shared | failed
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (handle) REFERENCES bot_profiles(handle)
);
CREATE INDEX IF NOT EXISTS idx_bot_runs_handle ON bot_runs(handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_runs_status ON bot_runs(status, updated_at DESC);

-- Additive stamp so public shares can attribute a bot without overloading chat_id.
-- No FK on ALTER — D1/SQLite add-column FKs are unreliable; app code validates.
ALTER TABLE shared_chats ADD COLUMN bot_handle TEXT;
CREATE INDEX IF NOT EXISTS idx_shared_chats_bot ON shared_chats(bot_handle, created_at DESC);
