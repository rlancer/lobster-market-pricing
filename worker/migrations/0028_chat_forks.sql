-- Fork lineage for timeline follow-ups.
--
-- A signed-in user with a public handle can fork a shared chat into a new
-- owned Chat conversation (seeded from the share transcript). parent_share_id
-- points at the public share they continued from; fork_seed_count is how many
-- messages were copied into the new Durable Object so later shares can stamp
-- per-turn authors (original asker vs follow-up asker).

ALTER TABLE user_chats ADD COLUMN parent_share_id TEXT;
ALTER TABLE user_chats ADD COLUMN fork_seed_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_user_chats_parent_share
  ON user_chats(parent_share_id)
  WHERE parent_share_id IS NOT NULL;
