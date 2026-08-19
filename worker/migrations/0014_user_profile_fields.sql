-- Product profile fields beyond the public handle.
--
-- Google OAuth still owns Better Auth "user".name / "user".image. Display name
-- and (legacy) avatar_key live here. Custom avatar bytes moved to user_avatars
-- in 0015 — avatar_key is unused after that migration.

ALTER TABLE user_profiles ADD COLUMN display_name TEXT;
ALTER TABLE user_profiles ADD COLUMN avatar_key TEXT;
