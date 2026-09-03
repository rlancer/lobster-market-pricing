-- Chat tool-call debug log (table name historical) (0010).
--
-- Every CopilotAgent tool execution (success or failure) appends one row here
-- from the Durable Object — server-authoritative, never trusted from the
-- browser. Lake chat_history intentionally strips tools/errors; this table is
-- the durable admin debug surface for "why did that chat fail?".
--
-- Read path: GET /api/admin/tool_calls (Bearer ADMIN_TOKEN). Retention matches
-- conversation cleanup (~30 days); the Worker purges on turn start and on
-- admin read. Args/summary/error/sql are length-capped at insert time — never
-- store full result row tables here.

CREATE TABLE IF NOT EXISTS copilot_tool_events (
  event_id     TEXT PRIMARY KEY NOT NULL,
  chat_id      TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  args_json    TEXT NOT NULL,
  error        TEXT,
  summary      TEXT,
  sql_text     TEXT,
  duration_ms  INTEGER,
  model        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_tool_events_created
  ON copilot_tool_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_tool_events_chat_created
  ON copilot_tool_events(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_tool_events_ok_created
  ON copilot_tool_events(ok, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copilot_tool_events_tool_created
  ON copilot_tool_events(tool_name, created_at DESC);
