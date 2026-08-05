# Plans

Design docs / implementation plans for the screener. Write one markdown file per
feature before implementing. Current contents:

- `2026-08-05-cboe-data-pipeline-github-actions.md` — Replace Yahoo Finance with the
  CBOE delayed-quotes API and automate the refresh via a GitHub Actions cron workflow
  that does the ETL and uploads Parquet to R2.
