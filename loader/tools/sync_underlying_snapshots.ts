// One-time cutover backfill: project the run-history half of the retired
// options.underlyings table into options.underlying_snapshots WITHOUT
// re-fetching CBOE. Reads latest per-symbol rows via R2 SQL REST, remaps each
// to a snapshot record (adding the deterministic ticker-derived security_id),
// and publishes to the underlying_snapshots stream in bounded batches.
//
// Usage (from loader/):
//   R2_SQL_ACCOUNT_ID=... R2_SQL_BUCKET=... R2_SQL_TOKEN=... \
//   PIPELINE_UNDERLYING_SNAPSHOTS_URL=... PIPELINE_AUTH_TOKEN=... \
//   node tools/sync_underlying_snapshots.ts

import { securityIdForTicker } from "../src/symbology.ts";

const ACCOUNT = process.env.R2_SQL_ACCOUNT_ID || "";
const BUCKET = process.env.R2_SQL_BUCKET || "";
const TOKEN = process.env.R2_SQL_TOKEN || "";
const SNAPSHOT_URL = process.env.PIPELINE_UNDERLYING_SNAPSHOTS_URL || "";
const AUTH = process.env.PIPELINE_AUTH_TOKEN || "";

const BATCH = 250;

interface Row {
  symbol: string;
  name: string | null;
  sector: string | null;
  spot_price: number | null;
  run_id: string;
  as_of_date: string;
  fetched_at: string;
}

async function latestUnderlyings(): Promise<Row[]> {
  const sql =
    "SELECT symbol, name, sector, spot_price, run_id, as_of_date, fetched_at " +
    "FROM options.underlyings " +
    "QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC) = 1";
  const res = await fetch(
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${ACCOUNT}/r2-sql/query/${BUCKET}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    },
  );
  if (!res.ok) throw new Error(`R2 SQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body: unknown = await res.json();
  const rows = (body as { result?: { rows?: Row[] } }).result?.rows ?? [];
  return rows;
}

async function publish(records: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(SNAPSHOT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${AUTH}`, "content-type": "application/json", "user-agent": "cboe-to-r2/0.2" },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`pipeline HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

if (!SNAPSHOT_URL) { console.error("PIPELINE_UNDERLYING_SNAPSHOTS_URL not set"); process.exit(1); }
const rows = await latestUnderlyings();
console.log(`found ${rows.length} latest underlying rows`);

let published = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH).map((r) => ({
    security_id: securityIdForTicker(r.symbol),
    ticker: r.symbol,
    spot_price: r.spot_price ?? null,
    name: r.name ?? null,
    sector: r.sector ?? null,
    run_id: r.run_id,
    as_of_date: String(r.as_of_date ?? ""),
    fetched_at: r.fetched_at,
  }));
  await publish(chunk);
  published += chunk.length;
  console.log(`published ${published}/${rows.length}`);
}
console.log("done");
