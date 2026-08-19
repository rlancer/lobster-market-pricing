-- Restore D1 BLOB avatars.
--
-- Cloudflare Images hosted upload was writing user_profiles.avatar_key ids that
-- the Images binding could not retrieve (GET /api/avatars/{id} → 404), so the
-- crop preview flashed then snapped to a broken <img>. Store bytes in D1 again
-- and clear orphaned Images keys so profiles fall back to sunglasses until
-- re-upload.

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id      TEXT PRIMARY KEY NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL,
  updated_at   INTEGER NOT NULL
);

UPDATE user_profiles SET avatar_key = NULL WHERE avatar_key IS NOT NULL AND avatar_key != 'd1';
