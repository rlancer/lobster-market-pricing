-- Admin QA / test-run ledger. Shares stay unlisted (no bot_handle) so
-- overview e2e and other probes do not land on the Floor.

CREATE TABLE IF NOT EXISTS qa_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  pr_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_batches_created
  ON qa_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS qa_items (
  item_id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  handle TEXT,
  run_id TEXT,
  share_id TEXT NOT NULL,
  chat_id TEXT,
  status TEXT NOT NULL,
  verdict_ok INTEGER,
  verdict_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES qa_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_items_batch_created
  ON qa_items (batch_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_items_share
  ON qa_items (share_id);
