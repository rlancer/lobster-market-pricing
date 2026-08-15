-- Public handles for signed-in users.
--
-- Identity stays in Better Auth's "user" table (Google OAuth). Handle is the
-- product slug we'll hang public profiles / timeline posts off later — unique,
-- lowercase, URL-safe. Not a Better Auth username: that plugin is for
-- password login, and we do not want handle uniqueness mixed into the auth
-- schema. Future profile fields (bio, etc.) add columns here.
--
-- Public URLs will be /u/{handle}, not /{handle}, so they never collide with
-- /chat, /data, /docs, /share. Changing a handle today is allowed; a redirect
-- table for old slugs can land when those public URLs ship.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  handle     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
