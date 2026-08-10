-- Pending chat-history records (0002) for the screener-api Worker.
--
-- POST /api/chat/history publishes one record per completed chat turn to the
-- cboe_chat_history_v2 stream (→ options.chat_history). When the pipeline
-- publish fails (transient 5xx, auth rotation window), the normalized record
-- is buffered here instead of being dropped, and later /api/chat/history
-- calls drain the oldest pending rows first. `attempts` bounds re-publish
-- retries (capped at 5); rows past the cap are left for manual inspection —
-- never silently deleted.

CREATE TABLE IF NOT EXISTS pending_chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_chat_history_created
  ON pending_chat_history(created_at);