-- Account bots can attach more than one book (paper + specific Schwab
-- accounts). portfolio_ids is the source of truth; source/account_id stay
-- derived for older readers.

ALTER TABLE user_bots ADD COLUMN portfolio_ids TEXT NOT NULL DEFAULT '["paper"]';

UPDATE user_bots SET portfolio_ids = CASE
  WHEN portfolio_source = 'none' OR attach_portfolio = 0 THEN '[]'
  WHEN portfolio_source = 'paper' THEN '["paper"]'
  WHEN portfolio_source = 'schwab' AND IFNULL(portfolio_account_id, '') != ''
    THEN '["schwab:' || portfolio_account_id || '"]'
  WHEN portfolio_source = 'schwab' THEN '["schwab"]'
  WHEN portfolio_source = 'all' THEN '["paper","schwab"]'
  ELSE portfolio_ids
END;
