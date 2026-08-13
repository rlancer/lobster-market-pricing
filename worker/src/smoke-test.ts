/**
 * Pipeline smoke-test probes (loader README: symbol ZZZ / 2099-01-01) are
 * synthetic rows used to verify ingest. They must never surface as market data
 * in schema samples, SQL Lab, the screener, or Copilot results.
 */
const SMOKE_SYMBOLS = new Set(["ZZZ"]);
const SMOKE_DATE_PREFIX = "2099-01-01";
const SYMBOL_KEYS = ["symbol", "ticker"];
const DATE_KEYS = ["as_of_date", "expiration", "date", "fetched_at"];

function isSmokeSymbol(value: unknown): boolean {
  return typeof value === "string" && SMOKE_SYMBOLS.has(value.trim().toUpperCase());
}

function isSmokeDate(value: unknown): boolean {
  if (value == null) return false;
  return String(value).startsWith(SMOKE_DATE_PREFIX);
}

function isSmokeRunId(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith("probe-");
}

export function isSmokeTestRow(row: Record<string, unknown>): boolean {
  for (const key of SYMBOL_KEYS) {
    if (isSmokeSymbol(row[key])) return true;
  }
  for (const key of DATE_KEYS) {
    if (isSmokeDate(row[key])) return true;
  }
  if (isSmokeRunId(row.run_id)) return true;
  const values = Object.values(row);
  if (values.length === 1) {
    const value = values[0];
    if (isSmokeSymbol(value) || isSmokeDate(value) || isSmokeRunId(value)) return true;
  }
  return false;
}

export function dropSmokeTestRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.filter((row) => !isSmokeTestRow(row));
}
