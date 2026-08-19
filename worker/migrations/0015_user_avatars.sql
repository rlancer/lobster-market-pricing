-- Interim D1 BLOB storage for avatars (superseded by Cloudflare Images in 0016).
--
-- Kept so already-applied migrations stay byte-stable. 0016 drops this table.

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id      TEXT PRIMARY KEY NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  updated_at   INTEGER NOT NULL
);
