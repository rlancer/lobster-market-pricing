# Next Steps: Populate the Full CBOE Dataset

## Current state

The one-symbol end-to-end test completed successfully:

```text
CBOE → Worker Container → Cloudflare Pipeline → R2 Data Catalog Iceberg tables → R2 SQL
```

The AAPL test produced 3,618 option contracts and a complete refresh record.

Current infrastructure:

- R2 bucket: `cboe-options-data`
- Catalog namespace: `options`
- Tables: `option_contracts`, `underlyings`, `refresh_runs`
- Pipeline sinks and pipelines: created
- Worker: deployed at `cboe-to-r2.robertlancer.workers.dev`
- GitHub deployment: manual workflow in `.github/workflows/deploy-loader.yml`
- Pipeline HTTP authentication: **enabled** (Bearer token, rotated after
  the security audit — the old unauthenticated ingest URLs were leaked in
  public git history and have been rotated + scrubbed).
- Security fix (DONE 2026-08-06): Pipeline ingest URLs rotated to new
  authenticated streams; migrated from `wrangler.jsonc` vars to Wrangler
  secrets; redacted from all tracked docs; git history scrubbed via
  `git-filter-repo`. See `SECURITY-AUDIT.md` (CRITICAL — RESOLVED) and
  `FOLLOW-UP-ACTIONS.md`.
## Phase 1: Validate the one-symbol result

Use R2 SQL to verify the completed refresh:

```sql
SELECT run_id, status, expected_symbols, successful_symbols,
       failed_symbols, contract_count, completed_at
FROM options.refresh_runs
ORDER BY started_at DESC
LIMIT 10;
```

For the completed `run_id`, verify the contract count:

```sql
SELECT symbol, COUNT(*) AS contracts
FROM options.option_contracts
WHERE run_id = '<RUN_ID>'
GROUP BY symbol
ORDER BY contracts DESC;
```

Verify AAPL expiration and option type coverage:

```sql
SELECT expiration, type, COUNT(*) AS contracts
FROM options.option_contracts
WHERE run_id = '<RUN_ID>'
  AND symbol = 'AAPL'
GROUP BY expiration, type
ORDER BY expiration, type;
```

Confirm that the underlying table contains the corresponding AAPL row:

```sql
SELECT *
FROM options.underlyings
WHERE run_id = '<RUN_ID>'
  AND symbol = 'AAPL';
```

## Phase 2: Test failure publication

Before loading all symbols, run one deliberately invalid symbol together with a valid symbol.

Expected behavior:

- The valid symbol is counted as successful.
- The invalid symbol is recorded in `error_summary`.
- The refresh status is `failed`.
- The failed refresh is not selected as the active dataset.
- The previous complete refresh remains queryable.

Do not continue to the full load if an incomplete refresh can appear as the latest complete dataset.

## Phase 3: Prepare the full symbol list

The loader accepts an explicit `symbols` array. Prepare the intended S&P 500 symbol list before invoking it.

Requirements:

- Normalize symbols to uppercase.
- Remove duplicates.
- Confirm the expected count before sending the request.
- Account for symbols containing periods or other CBOE-specific formatting.
- Keep the list in the calling script or workflow; do not silently fall back to an empty list.

The repository now contains `symbols/sp500.json` with 503 normalized, deduplicated component symbols. The Worker and container are configured for a maximum of 503 symbols per request. Keep the first full attempt as one explicit refresh so the existing publication model can be validated end to end.

## Phase 4: Deploy the full-universe limit

The approved maximum is 503 symbols. Deploy the Worker/container through the manual GitHub Actions workflow:

1. Commit the configuration change.
2. Push to `main`.
3. Open the `Deploy loader (Worker + container)` workflow.
4. Run it manually.
5. Confirm the deployment succeeds before starting ingestion.

Do not configure a schedule yet.

## Phase 5: Run the full refresh

Use the protected Worker endpoint with the complete, deduplicated symbol list:

```powershell
$headers = @{
  Authorization = "Bearer $env:LOADER_TOKEN"
  "Content-Type" = "application/json"
}

$body = Get-Content .\symbols\sp500.json -Raw

Invoke-RestMethod `
  -Method Post `
  -Uri "https://cboe-to-r2.robertlancer.workers.dev/run" `
  -Headers $headers `
  -Body $body
```

The request must contain a body shaped like:

```json
{
  "symbols": ["AAPL", "MSFT", "NVDA"]
}
```

Record the returned `run_id`. Do not start a second refresh until the first result has been validated.

## Phase 6: Validate completeness and cost

Check:

- `status = 'complete'`
- `expected_symbols` equals the intended symbol count
- `successful_symbols` equals `expected_symbols`
- `failed_symbols = 0`
- `contract_count > 0`
- Every expected symbol has at least one contract row
- Every expected symbol has one underlying row
- No unexpected duplicate run publication exists

Track the first full-run storage and catalog usage in the Cloudflare dashboard. Avoid repeated full refreshes while debugging.

## Phase 7: Harden before recurring operation

Before enabling recurring refreshes:

- ~~Restore authenticated Pipeline HTTP ingestion~~ **Done** — ingest streams
  are authenticated (Bearer token); URLs rotated to Wrangler secrets.
- Remove unused Pipeline credentials from Cloudflare and GitHub.
- Add refresh retention and snapshot-expiration policy.
- Decide whether to retain an independent raw or normalized backup.
- Add alerting for failed or incomplete runs.
- Enable the continuous background loader (DO alarm loop — the intended
  replacement for a cron schedule) only after manual full refreshes are stable.
  Start with the modest defaults in `wrangler.jsonc` (`LOADER_BATCH_SIZE=10`,
  `LOADER_CADENCE_SECONDS=900`) and tune up with validation; see
  `README.md` → "Continuous background loader".
- Keep the previous complete refresh available during every new refresh.

R2 Data Catalog and R2 SQL are currently beta products. Keep a recoverable copy until several complete refresh cycles have been validated.
