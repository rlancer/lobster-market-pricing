-- Published experiment runs (server-driven results + the exact images fed to the LLM).
-- Public GET serves the latest run so visitors do not re-spend OpenRouter credits.
-- Images live in a child table so each data URL stays under D1 value size limits.

CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY NOT NULL,
  experiment_slug TEXT NOT NULL,
  model TEXT NOT NULL,
  seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  results_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_slug_created
  ON experiment_runs (experiment_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS experiment_run_images (
  run_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  data_url TEXT NOT NULL,
  PRIMARY KEY (run_id, image_id),
  FOREIGN KEY (run_id) REFERENCES experiment_runs(id) ON DELETE CASCADE
);
