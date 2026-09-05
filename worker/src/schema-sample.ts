/**
 * Lake schema samples for /api/tables (SQL Lab) and the cached table catalog.
 *
 * `SELECT * LIMIT n` on Iceberg returns recently written files first. On-demand
 * enrollment writes those files, so an unbounded sample can inject a private
 * book's just-looked-up ETFs into every chat prompt and the catalog UI.
 * Prefer a stable public symbol when the table has symbol/ticker.
 */

export const SCHEMA_SAMPLE_LIMIT = 3;
export const SCHEMA_SAMPLE_PUBLIC_SYMBOL = "SPY";

export type SchemaKeyColumn = "symbol" | "ticker" | "series_id" | "series_ticker";

export function schemaSampleColumn(
  columns: readonly { name: string }[],
): "symbol" | "ticker" | null {
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  if (names.has("symbol")) return "symbol";
  if (names.has("ticker")) return "ticker";
  return null;
}

/**
 * Column that defines "what lives in this table." Iceberg LIMIT samples
 * cannot establish this — use COUNT(DISTINCT) / GROUP BY instead.
 */
export function schemaUniverseColumn(
  columns: readonly { name: string }[],
): SchemaKeyColumn | null {
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  if (names.has("symbol")) return "symbol";
  if (names.has("ticker")) return "ticker";
  if (names.has("series_id")) return "series_id";
  if (names.has("series_ticker")) return "series_ticker";
  return null;
}

/** Row count plus distinct key count in one scan. */
export function schemaCountSql(
  table: string,
  columns: readonly { name: string }[],
): string {
  const quoted = String(table).replace(/"/g, "");
  const key = schemaUniverseColumn(columns);
  if (key) {
    return `SELECT COUNT(*) AS n, COUNT(DISTINCT ${key}) AS n_keys FROM options."${quoted}"`;
  }
  return `SELECT COUNT(*) AS n FROM options."${quoted}"`;
}

export function schemaSampleSql(
  table: string,
  columns: readonly { name: string }[],
  opts?: { limit?: number; symbol?: string },
): string {
  const limit = opts?.limit ?? SCHEMA_SAMPLE_LIMIT;
  const symbol = opts?.symbol ?? SCHEMA_SAMPLE_PUBLIC_SYMBOL;
  const quoted = String(table).replace(/"/g, "");
  const column = schemaSampleColumn(columns);
  if (column) {
    return `SELECT * FROM options."${quoted}" WHERE ${column} = '${symbol}' LIMIT ${limit}`;
  }
  return `SELECT * FROM options."${quoted}" LIMIT ${limit}`;
}
