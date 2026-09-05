-- Enrolled seed_options (0007).
--
-- Identifying a fund (lookup_symbols on a private book) must persist the
-- ticker for etf-daily holdings without adding it to the public CBOE options
-- / OHLC universe. seed_options=1 (default) keeps the prior behavior: the
-- ticker joins effectiveUniverse for cboe-options, ohlc-daily, and research.
-- seed_options=0 is holdings-only.

ALTER TABLE enrolled_symbols ADD COLUMN seed_options INTEGER NOT NULL DEFAULT 1;
