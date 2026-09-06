-- Ledger for the timeline quality gate + remediator so admins can
-- watch the monitor: mint decisions, fail-open, and later unlists.
CREATE TABLE IF NOT EXISTS quality_gate_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  allow INTEGER,
  source TEXT,
  reason TEXT,
  share_id TEXT,
  run_id TEXT,
  bot_handle TEXT,
  model TEXT,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_quality_gate_events_created
  ON quality_gate_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_gate_events_action_created
  ON quality_gate_events (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_gate_events_source_created
  ON quality_gate_events (source, created_at DESC);
