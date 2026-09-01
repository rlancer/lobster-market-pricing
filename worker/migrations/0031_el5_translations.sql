-- Cached EL5 (“explain like I’m 5”) rewrites of public shared posts.
-- Keyed by share_id; source_hash invalidates when the transcript heals/changes.
-- Generation log is the durable per-IP rate limit (cache hits never write here).

CREATE TABLE IF NOT EXISTS el5_translations (
  share_id     TEXT PRIMARY KEY NOT NULL,
  source_hash  TEXT NOT NULL,
  el5_text     TEXT NOT NULL,
  model        TEXT,
  computed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS el5_generation_log (
  ip           TEXT NOT NULL,
  computed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_el5_generation_log_ip
  ON el5_generation_log(ip, computed_at);
