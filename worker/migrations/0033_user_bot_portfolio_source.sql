-- Account bots pick a specific book (paper, one Schwab account, all
-- Schwab, or none) instead of a boolean that always loaded everything.

ALTER TABLE user_bots ADD COLUMN portfolio_source TEXT NOT NULL DEFAULT 'paper';
ALTER TABLE user_bots ADD COLUMN portfolio_account_id TEXT;

UPDATE user_bots
   SET portfolio_source = CASE WHEN attach_portfolio = 0 THEN 'none' ELSE 'all' END
 WHERE portfolio_source = 'paper';
