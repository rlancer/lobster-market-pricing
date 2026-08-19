-- Clear avatar rows that cannot be served (empty/unreadable BLOBs left avatar_key
-- set so profiles exposed /api/avatars URLs that 404'd after refresh).

DELETE FROM user_avatars WHERE data IS NULL OR length(data) < 32;

UPDATE user_profiles
SET avatar_key = NULL
WHERE avatar_key = 'd1'
  AND user_id NOT IN (SELECT user_id FROM user_avatars);
