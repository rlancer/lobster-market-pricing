-- Product profile fields beyond the public handle.
--
-- Google OAuth still owns Better Auth "user".name / "user".image. Display name
-- and custom avatar live here so the public surface is editable without mutating
-- the auth identity row. avatar_key is an R2 object key in the AVATARS bucket
-- (served at GET /api/avatars/{user_id}).

ALTER TABLE user_profiles ADD COLUMN display_name TEXT;
ALTER TABLE user_profiles ADD COLUMN avatar_key TEXT;
