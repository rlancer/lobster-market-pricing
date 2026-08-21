-- Private Copilot reply voice. Independent of the public handle so a signed-in
-- user can set desk/fund/learner (+ optional short note) before claiming /u/.

CREATE TABLE IF NOT EXISTS user_reply_prefs (
  user_id     TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  reply_style TEXT NOT NULL DEFAULT 'desk',
  reply_note  TEXT,
  updated_at  INTEGER NOT NULL
);
