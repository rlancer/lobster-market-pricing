import type { ChartSpec } from './chartSpec.ts';
import { chartFitsResult } from './chartSpec.ts';
import { mergeSqlQueries } from './sqlQueries.ts';

const FRAME_SLICE_RE = /^--\s*(?:slice|reduction) of cached frame/i;
const FRAME_SOURCE_RE = /^--\s*source:\s*([\s\S]+)/im;

export function executableSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;
  if (FRAME_SLICE_RE.test(trimmed)) {
    const source = trimmed.match(FRAME_SOURCE_RE);
    const body = source?.[1]?.trim() ?? '';
    return body || null;
  }
  if (/^--/.test(trimmed) && !/\bselect\b/i.test(trimmed)) return null;
  return trimmed;
}

function scoreSqlForChart(sql: string, spec: ChartSpec): number {
  const lower = sql.toLowerCase();
  let score = 0;
  if (lower.includes(spec.x.toLowerCase())) score += 2;
  if (lower.includes(spec.y.toLowerCase())) score += 2;
  if (spec.series && lower.includes(spec.series.toLowerCase())) score += 1;
  return score;
}

/** Prefer the query whose SQL mentions the chart columns — last SQL is often a later research hit. */
export function pickChartSqlCandidates(message: {
  sql?: string | null;
  queries?: string[] | null;
  frames?: { name: string; columns: string[]; sql: string }[] | null;
  chart?: ChartSpec | null;
}): string[] {
  const spec = message.chart ?? null;
  const raw = mergeSqlQueries(
    message.queries,
    message.sql ? [message.sql] : undefined,
    (message.frames ?? []).map((frame) => frame.sql),
  );
  const executable = raw.map(executableSql).filter((sql): sql is string => Boolean(sql));
  if (!spec) return executable.slice().reverse();
  const scored = executable
    .map((sql, index) => ({
      sql,
      score: scoreSqlForChart(sql, spec),
      // Stable tie-break: later queries first (they are usually the chart frame).
      recency: index,
    }))
    .sort((a, b) => b.score - a.score || b.recency - a.recency);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of scored) {
    if (seen.has(item.sql)) continue;
    seen.add(item.sql);
    out.push(item.sql);
  }
  return out;
}

export function chartSqlFitsColumns(spec: ChartSpec, columns: string[]): boolean {
  return chartFitsResult(spec, columns);
}
