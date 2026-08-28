-- Charles Schwab OAuth linkage (Trader API).
-- Tokens stay Worker-side in SCHEMA_DB — never returned to the browser.
-- One row per signed-in user; reconnect upserts.

CREATE TABLE IF NOT EXISTS schwab_connections (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT,
  expires_at INTEGER NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
