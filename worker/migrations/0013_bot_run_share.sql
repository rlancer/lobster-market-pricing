-- Bot run ↔ share link (0013).
--
-- Sharing a bot chat must be idempotent per bot_runs.run_id so a double-click
-- (or retry) cannot mint two shared_chats / timeline posts for the same run.
-- shared_chats.run_id is the durable share→run link; bot_runs.share_id is the
-- reverse pointer updated in the same POST /api/share/chat flow.

ALTER TABLE shared_chats ADD COLUMN run_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_chats_run_id
  ON shared_chats(run_id) WHERE run_id IS NOT NULL;
