-- Shared chats (0003) for the screener-api Worker.
--
-- POST /api/share/chat snapshots a Copilot conversation into D1 as a public,
-- unlisted, read-only artifact; GET /api/share/:id serves it (the share_id is
-- the implicit capability — base62 of ~18 random bytes, no auth, like a
-- GitHub gist id). The schema is the anchor a future scheduled_alerts table
-- references (source_sql is the denormalized last-executed query an alert
-- would rerun), so alerts build purely additively and this table never
-- changes afterwards.
--
-- Privacy: created_ip / created_ua are server-set abuse signals (exactly the
-- chat-history capture pattern — CF-Connecting-IP / User-Agent headers, never
-- the client body) and are NEVER included in GET /api/share/:id responses.

CREATE TABLE IF NOT EXISTS shared_chats (
  share_id    TEXT PRIMARY KEY,   -- base62 ~18-byte entropy: the URL slug (implicit capability)
  chat_id     TEXT NOT NULL,      -- originating conversation id (matches options.chat_history)
  title       TEXT,               -- auto-derived (first user question) / user-editable later
  mode        TEXT NOT NULL,      -- 'funded' (site-key, server-side Copilot)
  model       TEXT,               -- model id that answered
  messages    TEXT NOT NULL,      -- JSON array [{role, content, sql?, tools?, ts?}] — the transcript
  source_sql  TEXT,               -- the "money" query (last assistant sql) denormalized for alert wiring
  created_ip  TEXT,               -- server-set abuse signal (CF-Connecting-IP); admin-only, NEVER served
  created_ua  TEXT,               -- server-set abuse signal (User-Agent); admin-only, NEVER served
  created_at  INTEGER NOT NULL,   -- epoch ms
  updated_at  INTEGER NOT NULL,   -- epoch ms; bumped on title/transcript edits
  expires_at  INTEGER             -- epoch ms; NULL = never (TTL for revocable shares)
);

CREATE INDEX IF NOT EXISTS idx_shared_chats_chat    ON shared_chats(chat_id);
CREATE INDEX IF NOT EXISTS idx_shared_chats_created ON shared_chats(created_at);
CREATE INDEX IF NOT EXISTS idx_shared_chats_ip      ON shared_chats(created_ip);
CREATE INDEX IF NOT EXISTS idx_shared_chats_expires ON shared_chats(expires_at);