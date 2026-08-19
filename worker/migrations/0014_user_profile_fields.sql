-- Product profile fields beyond the public handle.
--
-- Google OAuth still owns Better Auth "user".name / "user".image. Display name
-- and (legacy) avatar_key live here. avatar_key holds the Cloudflare Images
-- id after 0016; 0015's user_avatars blob table is dropped by that migration.

ALTER TABLE user_profiles ADD COLUMN display_name TEXT;
ALTER TABLE user_profiles ADD COLUMN avatar_key TEXT;
