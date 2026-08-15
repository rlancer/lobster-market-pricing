-- Public timeline (0009).
--
-- shared_chats stays an unlisted capability (migration 0003). Listing a share
-- on the home feed is a separate, authenticated opt-in: the share dialog
-- publishes a row here. Unpublish deletes the row; the unlisted share remains.
-- Ownership is stamped when a signed-in user mints the share so only the
-- author can list it. Anonymous shares cannot be posted to the timeline.

CREATE TABLE IF NOT EXISTS share_owners (
  share_id    TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_owners_user ON share_owners(user_id);

CREATE TABLE IF NOT EXISTS timeline_posts (
  share_id      TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL,
  excerpt       TEXT,
  has_sql       INTEGER NOT NULL DEFAULT 0,
  has_chart     INTEGER NOT NULL DEFAULT 0,
  published_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_posts_published
  ON timeline_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_posts_user
  ON timeline_posts(user_id, published_at DESC);
