-- Blank chats claimed on open (before first user turn) landed in user_chats
-- with a NULL title and rendered as "Untitled chat" in the sidebar.
-- Soft-delete them so history only lists conversations that have a title.
-- Ownership stays locked (deleted_at set); a later claim with a real title
-- can undelete the row.

UPDATE user_chats
SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE deleted_at IS NULL
  AND (title IS NULL OR TRIM(title) = '');
