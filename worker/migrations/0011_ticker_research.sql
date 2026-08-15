-- Ticker identity + research cache + chat ↔ security graph.
--
-- When Copilot discusses or suggests a trade, it resolves the ticker through
-- OpenFIGI (with lake fallback), stores the normalized identity, links the
-- chat to that security_id, and caches a research brief for the UI widget
-- and /research/:ticker route. Chats that span the same security can be
-- joined via chat_tickers without relying on free-text symbol matching.
--
-- ticker_identities is keyed by ticker so aliases (input vs OpenFIGI
-- canonical) can share one security_id.

CREATE TABLE IF NOT EXISTS ticker_identities (
  ticker         TEXT PRIMARY KEY,
  security_id    TEXT NOT NULL,
  figi           TEXT,
  composite_figi TEXT,
  isin           TEXT,
  name           TEXT,
  exchange       TEXT,
  currency       TEXT,
  sector         TEXT,
  source         TEXT NOT NULL,
  resolved_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticker_identities_security
  ON ticker_identities(security_id);
CREATE INDEX IF NOT EXISTS idx_ticker_identities_figi
  ON ticker_identities(figi);
CREATE INDEX IF NOT EXISTS idx_ticker_identities_composite
  ON ticker_identities(composite_figi);

CREATE TABLE IF NOT EXISTS chat_tickers (
  chat_id        TEXT NOT NULL,
  security_id    TEXT NOT NULL,
  ticker         TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  mention_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (chat_id, security_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_tickers_security
  ON chat_tickers(security_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_tickers_chat
  ON chat_tickers(chat_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS ticker_research (
  security_id  TEXT PRIMARY KEY,
  ticker       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticker_research_expires
  ON ticker_research(expires_at);
CREATE INDEX IF NOT EXISTS idx_ticker_research_ticker
  ON ticker_research(ticker);
