-- Move custom avatars off D1 BLOBs onto Cloudflare Images.
--
-- user_profiles.avatar_key (from 0014) stores the Cloudflare Images id.
-- Bytes live in Images; GET /api/avatars/{user_id} streams via the IMAGES
-- binding. Drop the interim user_avatars blob table.

DROP TABLE IF EXISTS user_avatars;
