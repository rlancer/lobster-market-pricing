-- Completed Chat results kept for resume (0004) for the screener-api Worker.
--
-- On mobile, backgrounding the tab tears down the in-flight SSE stream before
-- the final `result` event arrives, and there is no second chance to fetch it:
-- the Worker keeps running the agent after the client disconnects and was
-- discarding the finished answer. This table stores that completed result
-- keyed by the client's (unguessable) chat_id so a reconnecting client can
-- poll GET /api/chat/result and recover the answer instead of seeing a fatal
-- "network error". Rows are TTL'd/lazily pruned; chat_id is the capability,
-- same model as shared_chats.

CREATE TABLE IF NOT EXISTS chat_results (
  chat_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
