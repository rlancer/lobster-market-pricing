-- Durable cache for Tavily news + web search responses.
--
-- /api/news, /api/web_search, and the timeline/chat rail previously memoized
-- results only in an isolate-local Map. Cloudflare Workers spin up many
-- isolates, so that memo did not stop repeat credit burn for the same
-- symbol/query across users or cold starts. Store successes in D1 keyed by
-- a stable cache key; expires_at is epoch-ms. Failures are never written —
-- the next caller retries Tavily. D1 is a performance layer only: read/write
-- errors fall through to a live fetch and never 500 the request.

CREATE TABLE IF NOT EXISTS tavily_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tavily_cache_expires
  ON tavily_cache(expires_at);
