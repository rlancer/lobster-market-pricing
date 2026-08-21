-- Dedupe log for moderation → GitHub improvement issues.
-- fingerprint is a stable kebab slug from the reviewer (e.g. cutoff-tool-loop).
-- One row per fingerprint keeps repeat rejects from spamming the issue tracker.
CREATE TABLE IF NOT EXISTS improvement_reports (
  fingerprint TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  issue_number INTEGER,
  issue_url TEXT,
  share_id TEXT,
  run_id TEXT,
  bot_handle TEXT,
  moderation_action TEXT,
  moderation_allow INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_improvement_reports_created
  ON improvement_reports (created_at DESC);
