-- Grade-on-close queue for Kalshi sports parlays (0008).
--
-- The settled/closed Get Markets lookback scans are windowed at the 12x200
-- alphabetical head, and sportsTapePinTickers only keeps pinned tickers that
-- the window already fetched — so most tape tickers never got a
-- source=kalshi_settlement row (measured 2026-09-18: 34 of 8,078 RFQ-quoted
-- tickers graded; 73% of closed two-leg combos). The queue closes that hole:
-- every listed two-leg combo on the hourly tape plus every RFQ / fill
-- ticker is enqueued when first seen; once close_time passes, passes fetch
-- it by ticker and publish a settlement 0/1 row. Graded rows are deleted;
-- entries older than KALSHI_SETTLEMENT_QUEUE_DAYS (default 45) are pruned.

CREATE TABLE IF NOT EXISTS kalshi_settlement_queue (
  market_ticker TEXT PRIMARY KEY,
  close_time    TEXT NOT NULL,
  enqueued_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kalshi_settlement_queue_due
  ON kalshi_settlement_queue (close_time);