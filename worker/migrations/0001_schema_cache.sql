-- Lake schema cache (0001) for the screener-api Worker.
--
-- /api/tables computes the lake schema via several R2 SQL round trips
-- (SHOW TABLES, then DESCRIBE + COUNT + sample per table). That payload is
-- read on every AI chat question and when the SQL Lab sidebar loads, so it is
-- stored here and only recomputed when the TTL expires or on explicit
-- ?force=1. Row model: one row per cached payload, keyed by name.
--
-- freshness: `expires_at` is an epoch-ms deadline; reads treat the row as
-- stale once Date.now() >= expires_at and recompute from R2 SQL. Schema
-- structure changes (new tables/columns from a loader deploy) therefore show
-- up within at most one TTL, and the SQL Lab refresh button forces it
-- immediately.

CREATE TABLE IF NOT EXISTS schema_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);