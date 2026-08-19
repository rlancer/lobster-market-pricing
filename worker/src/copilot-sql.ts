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

export interface SynonymRewriteResult {
  /** SQL after applying ticker↔symbol synonyms for the live schema. */
  sql: string;
  /** Human-readable notes like `underlying_snapshots.symbol → ticker`. */
  rewrites: string[];
}

const SQL_ALIAS_KEYWORDS: Record<string, true> = {
  select: true, from: true, where: true, join: true, left: true, right: true,
  full: true, inner: true, outer: true, cross: true, on: true, group: true,
  order: true, limit: true, qualify: true, having: true, union: true, as: true,
  and: true, or: true, when: true, then: true, else: true, end: true, case: true,
  with: true, by: true, asc: true, desc: true, nulls: true, first: true,
  last: true, over: true, partition: true, distinct: true, all: true,
};

/** Known OCC-root column synonyms that differ across lake tables. */
const COLUMN_SYNONYMS: Array<[string, string]> = [
  ["symbol", "ticker"],
  ["ticker", "symbol"],
];

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

/**
 * Map a transform over SQL chunks that are outside string literals / comments
 * so synonym rewrites never touch data values like WHERE name = 'symbol'.
 */
function mapSqlOutsideLiterals(sql: string, transform: (chunk: string) => string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end + 1;
      parts.push(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      parts.push(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      parts.push(sql.slice(i, j));
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < sql.length && sql[j] !== "'" && !sql.startsWith("--", j) && !sql.startsWith("/*", j)) j += 1;
    parts.push(transform(sql.slice(i, j)));
    i = j;
  }
  return parts.join("");
}

/**
 * CTE names declared via `WITH name AS (` / `WITH name (cols) AS (`.
 * These are valid FROM/JOIN targets and must not be reported as unknown lake
 * tables (regression: Copilot burned whole turns flattening CTEs after a
 * false "Unknown table options.base" reject).
 */
function declaredCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  if (!/^\s*with\b/i.test(sql)) return names;
  for (const match of sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) {
    const name = match[1].toLowerCase();
    if (!SQL_ALIAS_KEYWORDS[name]) names.add(name);
  }
  return names;
}

function columnNames(table: LakeTable): Set<string> {
  return new Set(table.columns.map((c) => c.name.toLowerCase()));
}

function resolveTableAliases(sql: string, tables: LakeTable[]): Map<string, LakeTable> {
  const tableMap = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  const aliases = new Map<string, LakeTable>();
  const tablePattern = /\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:as\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of sql.matchAll(tablePattern)) {
    const table = tableMap.get(match[1].toLowerCase());
    if (!table) continue;
    aliases.set(match[1].toLowerCase(), table);
    if (match[2] && !SQL_ALIAS_KEYWORDS[match[2].toLowerCase()]) {
      aliases.set(match[2].toLowerCase(), table);
    }
  }
  return aliases;
}

function referencedLakeTables(sql: string, tables: LakeTable[]): LakeTable[] {
  const tableMap = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
  const ctes = declaredCteNames(sql);
  const out: LakeTable[] = [];
  const seen = new Set<string>();
  for (const match of sql.matchAll(/\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)\b/gi)) {
    const name = match[1].toLowerCase();
    if (ctes.has(name) || seen.has(name)) continue;
    const table = tableMap.get(name);
    if (!table) continue;
    seen.add(name);
    out.push(table);
  }
  return out;
}

/**
 * Rewrite ticker↔symbol when the live schema has only one of the pair.
 *
 * The lake is inconsistent by design today: option_contracts / ohlc /
 * realized_vol / earnings use `symbol`; underlying_snapshots / securities /
 * fundamentals / ETF tables use `ticker`. Copilot (and humans) routinely
 * write the wrong name; this normalizes against DESCRIBE before R2 SQL.
 */
export function applyColumnSynonyms(sql: string, tables: LakeTable[]): SynonymRewriteResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  const aliases = resolveTableAliases(trimmed, tables);
  const notes = new Set<string>();

  let next = mapSqlOutsideLiterals(trimmed, (chunk) =>
    chunk.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g, (full, qualRaw: string, colRaw: string) => {
      const qualifier = qualRaw.toLowerCase();
      if (qualifier === "options") return full;
      const table = aliases.get(qualifier);
      if (!table) return full;
      const cols = columnNames(table);
      const col = colRaw.toLowerCase();
      if (cols.has(col)) return full;
      for (const [from, to] of COLUMN_SYNONYMS) {
        if (col === from && cols.has(to) && !cols.has(from)) {
          notes.add(`${table.name}.${from} → ${to}`);
          return `${qualRaw}.${to}`;
        }
      }
      return full;
    }),
  );

  // Unqualified synonym only when every referenced lake table agrees on the
  // rewrite (e.g. sole underlying_snapshots query using `symbol`). Mixed joins
  // keep unqualified names alone — the model must qualify them.
  const lakeTables = referencedLakeTables(next, tables);
  if (lakeTables.length > 0) {
    for (const [from, to] of COLUMN_SYNONYMS) {
      const allAgree = lakeTables.every((table) => {
        const cols = columnNames(table);
        return cols.has(to) && !cols.has(from);
      });
      if (!allAgree) continue;
      const before = next;
      next = mapSqlOutsideLiterals(next, (chunk) =>
        // Skip intentional aliases: `AS symbol` / `AS ticker`.
        chunk.replace(new RegExp(`(?<!\\b[Aa][Ss]\\s+)\\b${from}\\b`, "g"), to),
      );
      if (next !== before) {
        notes.add(`unqualified ${from} → ${to}`);
      }
    }
  }

  return { sql: next, rewrites: [...notes] };
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
  const ctes = declaredCteNames(trimmed);
  const references = [...trimmed.matchAll(/\b(?:from|join)\s+(?:options\.)?([A-Za-z_][A-Za-z0-9_]*)\b/gi)];
  // R2 SQL rejects table-less probes (`SELECT 1`, `SELECT 'test' AS t`) with
  // "query must reference at least one table". Catch that before the lake call
  // so forced run_query loops cannot burn the turn on the same error.
  const lakeTableReferenced = references.some((match) => tableMap.has(match[1].toLowerCase()));
  if (!lakeTableReferenced) {
    if (references.length === 0) {
      issues.push({
        severity: "error",
        message: "SQL must reference at least one lake table via FROM/JOIN (bare SELECT probes are not allowed).",
      });
    } else if (references.every((match) => ctes.has(match[1].toLowerCase()))) {
      issues.push({
        severity: "error",
        message: "CTE-only SQL must still SELECT FROM at least one options.* lake table in a CTE body.",
      });
    }
  }
  for (const match of references) {
    const name = match[1].toLowerCase();
    if (ctes.has(name)) continue;
    if (!tableMap.has(name) && !/^\w+$/.test(name)) continue;
    if (!tableMap.has(name)) issues.push({ severity: "error", message: `Unknown table options.${match[1]}.` });
  }

  const aliases = resolveTableAliases(trimmed, tables);
  for (const match of trimmed.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const qualifier = match[1].toLowerCase();
    if (qualifier === "options") continue;
    if (ctes.has(qualifier)) continue;
    const table = aliases.get(qualifier);
    if (!table) continue;
    const column = match[2].toLowerCase();
    if (!table.columns.some((candidate) => candidate.name.toLowerCase() === column)) {
      issues.push({ severity: "error", message: `Unknown column ${match[1]}.${match[2]} on options.${table.name}.` });
    }
  }
  return issues;
}
