/** Cap on SQL statements kept per assistant turn (share / Floor / live chat). */
export const MAX_SQL_QUERIES = 20;

/** First-seen unique SQLs, trimmed, capped. Later duplicates are dropped. */
export function mergeSqlQueries(
  ...lists: Array<readonly string[] | null | undefined>
): string[] {
  const out: string[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      const sql = typeof raw === 'string' ? raw.trim() : '';
      if (!sql || out.includes(sql)) continue;
      out.push(sql);
      if (out.length >= MAX_SQL_QUERIES) return out;
    }
  }
  return out;
}

/** Every lake query on a transcript turn — `queries[]` plus legacy singular `sql`. */
export function sqlQueriesFromMessage(message: {
  sql?: string | null;
  queries?: string[] | null;
}): string[] {
  return mergeSqlQueries(message.queries, message.sql ? [message.sql] : undefined);
}
