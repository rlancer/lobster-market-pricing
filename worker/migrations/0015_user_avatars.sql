-- Custom profile photos as D1 BLOBs (user_avatars).
--
-- Served at GET /api/avatars/{user_id}. Requires a claimed handle (FK to
-- user_profiles). avatar_key on user_profiles from 0014 is unused; left in
-- place so we do not rewrite an already-applied migration.

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id      TEXT PRIMARY KEY NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  updated_at   INTEGER NOT NULL
);
