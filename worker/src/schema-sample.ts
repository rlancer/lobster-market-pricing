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

export function schemaSampleColumn(
  columns: readonly { name: string }[],
): "symbol" | "ticker" | null {
  const names = new Set(columns.map((column) => column.name.toLowerCase()));
  if (names.has("symbol")) return "symbol";
  if (names.has("ticker")) return "ticker";
  return null;
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
