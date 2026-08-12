/**
 * Pure SQL validation for the Copilot run_query/check_schema tools.
 *
 * Kept free of any Workers-runtime imports so it is unit-testable in plain
 * Node (copilot.ts pulls in @cloudflare/ai-chat + agents, which only run
 * inside the Workers runtime).
 */

export interface LakeTable {
  name: string;
  row_count: number | null;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}

export interface ValidatedIssue {
  severity: "error" | "warning";
  message: string;
}

const SQL_ALIAS_KEYWORDS: Record<string, true> = {
  select: true, from: true, where: true, join: true, left: true, right: true,
  full: true, inner: true, outer: true, cross: true, on: true, group: true,
  order: true, limit: true, qualify: true, having: true, union: true, as: true,
  and: true, or: true, when: true, then: true, else: true, end: true, case: true,
  with: true, by: true, asc: true, desc: true, nulls: true, first: true,
  last: true, over: true, partition: true, distinct: true, all: true,
};

/**
 * Return a copy of the SQL with single-quoted string literals and comments
 * removed, so statement-structure checks (multiple statements, mutating
 * keywords) don't false-positive on string data. R2 SQL escapes an embedded
 * quote as '' (standard SQL), which the `(?:''[^']*)*` term handles. Deliberately
 * leaves double-quoted identifiers intact — they're structural, not data.
 */
function stripSqlLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^']*(?:''[^']*)*'/g, "");
}

export function validateSqlSchema(sql: string, tables: LakeTable[]): ValidatedIssue[] {
  const issues: ValidatedIssue[] = [];
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  // Structural checks run on the literal/comment-stripped SQL: the options
  // domain filters on type = 'call' / 'put' constantly, and 'call' is a banned
  // mutating keyword — matching inside a string literal wrongly rejects every
  // such query as "Mutating SQL is not allowed."
  const structural = stripSqlLiteralsAndComments(trimmed);
  if (!/^(select|with)\b/i.test(trimmed)) issues.push({ severity: "error", message: "Only SELECT or WITH queries are allowed." });
  if (/;/.test(structural)) issues.push({ severity: "error", message: "Multiple SQL statements are not allowed." });
  if (/\b(insert|update|delete|drop|alter|create|truncate|copy|call|merge)\b/i.test(structural)) issues.push({ severity: "error", message: "Mutating SQL is not allowed." });
  if (!/\blimit\s+\d+\b/i.test(trimmed)) issues.push({ severity: "warning", message: "The query should end with an explicit LIMIT." });
  if (/\boffset\b/i.test(trimmed)) issues.push({ severity: "error", message: "OFFSET is not supported." });
  if (/\bcross\s+join\b/i.test(trimmed)) issues.push({ severity: "error", message: "CROSS JOIN is not allowed." });
  if (/\bwindow\s+[A-Za-z_]/i.test(trimmed)) issues.push({ severity: "error", message: "Named WINDOW clauses are not supported." });

  const tableMap = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  const references = [...trimmed.matchAll(/\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)\b/gi)];
  for (const match of references) {
    const name = match[1].toLowerCase();
    if (!tableMap.has(name) && !/^\w+$/.test(name)) continue;
    if (!tableMap.has(name)) issues.push({ severity: "error", message: `Unknown table options.${match[1]}.` });
  }

  const aliases = new Map<string, LakeTable>();
  const tablePattern = /\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of trimmed.matchAll(tablePattern)) {
    const table = tableMap.get(match[1].toLowerCase());
    if (!table) continue;
    aliases.set(match[1].toLowerCase(), table);
    if (match[2] && !SQL_ALIAS_KEYWORDS[match[2].toLowerCase()]) aliases.set(match[2].toLowerCase(), table);
  }
  for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const qualifier = match[1].toLowerCase();
    if (qualifier === "options") continue;
    const table = aliases.get(qualifier);
    if (!table) continue;
    const column = match[2].toLowerCase();
    if (!table.columns.some((candidate) => candidate.name.toLowerCase() === column)) {
      issues.push({ severity: "error", message: `Unknown column ${match[1]}.${match[2]} on options.${table.name}.` });
    }
  }
  return issues;
}