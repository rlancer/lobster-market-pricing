-- Enrolled symbol security type (0006).
--
-- On-demand enrollment used to treat every ticker as an equity. When Copilot
-- looks up a fund (RSP, VGSH, …) we persist security_type so:
--   - etf-daily unions these tickers into options.etf_profiles / etf_holdings
--   - instruments-daily classifies them as etf instead of equity
-- Bundled optionable ETFs stay in symbols/etfs.json; this column is only for
-- names that arrive via POST /symbols/enroll.

ALTER TABLE enrolled_symbols ADD COLUMN security_type TEXT;
