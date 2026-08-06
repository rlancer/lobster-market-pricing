# CBOE Options Data Loading Plan

## Goal

Replace the current full-refresh path:

```text
CBOE → DuckDB → Parquet → fixed-key R2 objects
```

with a loader-only pipeline:

```text
CBOE → Cloudflare Pipeline → R2 Data Catalog Iceberg tables → R2 SQL
```

This project is limited to data acquisition, normalization, durable ingestion, and query validation. It does not include React, Vite, Pages, browser SQL, or UI work.

## Product responsibilities

- **CBOE loader:** Fetch option chains, normalize OCC symbols and CBOE fields, apply retry policy, attach refresh metadata, and validate each symbol.
- **Cloudflare Pipelines:** Receive bounded HTTP batches, buffer incoming records, and write them to Iceberg tables.
- **R2 Data Catalog:** Manage Iceberg namespaces, tables, metadata, commits, and snapshots in R2.
- **R2 SQL:** Query and validate Iceberg tables. It is not the ingestion layer.

References:

- [R2 Data Catalog](https://developers.cloudflare.com/r2/data-catalog/)
- [R2 Data Catalog management and authentication](https://developers.cloudflare.com/r2/data-catalog/manage-catalogs/)
- [R2 SQL getting started](https://developers.cloudflare.com/r2-sql/get-started/)
- [R2 SQL reference](https://developers.cloudflare.com/r2-sql/sql-reference/)

## Why streaming ingestion

The existing loader fetches approximately 503 symbols, retains all normalized results in memory, writes a local DuckDB snapshot, exports complete Parquet tables, and replaces fixed R2 object keys. This creates memory pressure, a fragile local staging dependency, full-table rewrites, and no catalog-level snapshot history.

The new loader should fetch and send bounded batches incrementally:

```text
for each CBOE symbol:
  fetch complete chain
  normalize records
  attach run_id/as_of_date/fetched_at
  POST bounded records to a Pipeline endpoint
```

The loader should not accumulate the complete dataset or create Parquet files itself.

## Snapshot model

CBOE data is a periodic full snapshot rather than an unbounded event stream. Pipeline ingestion is append-oriented, so every record must carry refresh identity. Do not append records without a way to distinguish refreshes.

Every contract and underlying record should include:

```text
run_id
as_of_date
fetched_at
symbol
```

The contract table should retain the existing normalized fields:

```text
symbol
expiration
type
strike
last
bid
ask
volume
open_interest
implied_vol
delta
gamma
theta
vega
rho
in_the_money
theo
bid_size
ask_size
run_id
as_of_date
fetched_at
```

## Tables

Create an `options` namespace and these tables:

### `options.option_contracts`

One row per normalized CBOE option contract per refresh.

### `options.underlyings`

One row per underlying symbol per refresh, including spot price and descriptive metadata.

### `options.refresh_runs`

Control and publication metadata:

```text
run_id
started_at
completed_at
as_of_date
expected_symbols
successful_symbols
failed_symbols
contract_count
status
error_summary
```

Recommended status values:

```text
running
complete
failed
```

A refresh becomes queryable as the active dataset only when its status is `complete`.

## End-to-end workflow

1. Generate a unique `run_id`.
2. Insert a `running` record into `options.refresh_runs`.
3. Fetch the S&P 500 symbol list.
4. Fetch each CBOE chain with bounded memory.
5. Normalize OCC symbols and CBOE fields.
6. Send normalized contract batches to the Pipeline endpoint.
7. Send underlying records to the underlying Pipeline/table.
8. Record per-symbol success or failure.
9. Validate expected symbol count, contract counts, required fields, and error count.
10. Mark the run `complete` only if all required validation passes.
11. Mark the run `failed` otherwise; leave the previous complete run active.
12. Run R2 SQL smoke queries against the catalog tables.

## Querying the latest complete refresh

Use the refresh-control table to select the active dataset rather than deleting or overwriting prior rows:

```sql
WITH latest AS (
  SELECT run_id
  FROM options.refresh_runs
  WHERE status = 'complete'
  ORDER BY completed_at DESC
  LIMIT 1
)
SELECT c.*
FROM options.option_contracts AS c
JOIN latest AS l ON c.run_id = l.run_id;
```

Useful validation queries:

```sql
SHOW NAMESPACES;
SHOW TABLES IN options;
DESCRIBE options.option_contracts;
```

```sql
SELECT run_id, status, expected_symbols, successful_symbols,
       failed_symbols, contract_count, completed_at
FROM options.refresh_runs
ORDER BY started_at DESC
LIMIT 10;
```

```sql
SELECT symbol, COUNT(*) AS contracts
FROM options.option_contracts
WHERE run_id = '<RUN_ID>'
GROUP BY symbol
ORDER BY contracts DESC;
```

```sql
SELECT expiration, type, COUNT(*) AS contracts
FROM options.option_contracts
WHERE run_id = '<RUN_ID>'
  AND symbol = 'AAPL'
GROUP BY expiration, type
ORDER BY expiration, type;
```

## Authentication

Use separate credentials by role:

- **Loader/Pipeline sink:** R2 Data Catalog and R2 storage read/write permissions.
- **Query validation:** R2 Data Catalog and R2 storage read-only permissions.

Never commit tokens. Supply the R2 SQL token through `WRANGLER_R2_SQL_AUTH_TOKEN` or an ignored local environment file. Store CI credentials in GitHub Actions secrets.

## Initial implementation boundary

The first implementation should be a small end-to-end experiment:

1. Create or select one R2 bucket.
2. Enable R2 Data Catalog on that bucket.
3. Create the `options` namespace and minimal table schemas.
4. Configure a Pipeline HTTP endpoint for a small schema.
5. Load one to three CBOE symbols.
6. Run the completeness and schema validations.
7. Query the resulting Iceberg table with R2 SQL.
8. Verify that a failed/incomplete run does not replace the previous complete run.

Do not add UI code, frontend deployment, browser query code, or static Parquet serving.

## Design risks to resolve during implementation

- Pipeline append semantics versus full-snapshot publication.
- How to represent the `refresh_runs` control record using the selected ingestion path.
- Batch size and Pipeline roll settings for CBOE chain payloads.
- Idempotency and retry behavior when an HTTP batch is acknowledged ambiguously.
- Whether catalog table maintenance should enable compaction and snapshot expiration immediately.
- Whether direct PyIceberg writes are required if Pipeline cannot provide the required publication semantics.

## Decision

Use Cloudflare Pipelines for streaming/bounded ingestion and R2 Data Catalog for durable Iceberg tables. Use R2 SQL for analytical querying and validation. Treat each CBOE refresh as an immutable run and publish it through a completion marker; never expose partial refreshes as the active dataset.
