/**
 * Assertions for a live @nowlobster (or other overview) headless run.
 *
 * The original leak (share wnJWqaRxtCu1I3CLJIgCiaon) was an unfiltered
 * option_contracts GROUP BY that treated just-enrolled book names as flow.
 * A passing run must load get_market_tape and must not rank those names
 * via raw lake SQL.
 */

export const LEAK_BOOK_SYMBOLS = ["EWY", "RSP", "SIVR", "VEU", "VGSH", "CYTK"] as const;

export interface OverviewToolEvent {
  tool_name: string;
  ok: boolean;
  sql?: string | null;
  summary?: string | null;
}

export interface OverviewRunVerdict {
  ok: boolean;
  reasons: string[];
}

/** True when SQL is the "what's the tape" probe: volume rank, no sleeve IN (). */
export function isUnfilteredOptionFlowSql(sql: string): boolean {
  const s = sql.replace(/\s+/g, " ").toLowerCase();
  if (!s.includes("option_contracts")) return false;
  if (!/\bgroup by\b/.test(s)) return false;
  if (!/\bsymbol\b/.test(s)) return false;
  if (!/\b(sum\s*\(\s*volume|order by\s+\w*vol)/.test(s)) return false;
  if (/\bsymbol\s+in\s*\(/.test(s)) return false;
  return true;
}

export function leakSymbolsInTapeSummary(summary: string): string[] {
  const found: string[] = [];
  for (const symbol of LEAK_BOOK_SYMBOLS) {
    const re = new RegExp(`\\b${symbol}\\b\\s+(call|put)\\b`, "i");
    if (re.test(summary)) found.push(symbol);
  }
  return found;
}

export function judgeOverviewRun(input: {
  triggerOk: boolean;
  shareId?: string | null;
  error?: string | null;
  tools: OverviewToolEvent[];
}): OverviewRunVerdict {
  const reasons: string[] = [];
  if (!input.triggerOk) {
    reasons.push(input.error?.trim() || "schedule trigger failed");
    return { ok: false, reasons };
  }
  if (!input.shareId?.trim()) {
    reasons.push("trigger returned no share_id");
  }

  const tape = input.tools.filter((row) => row.tool_name === "get_market_tape");
  if (tape.length === 0) {
    reasons.push("get_market_tape was not called");
  } else if (!tape.some((row) => row.ok)) {
    reasons.push("get_market_tape ran but did not succeed");
  } else {
    const summary = tape.find((row) => row.ok)?.summary ?? "";
    if (!/liquid sleeve/i.test(summary)) {
      reasons.push("get_market_tape summary is missing the liquid-sleeve contract");
    }
    const leaked = leakSymbolsInTapeSummary(summary);
    if (leaked.length) {
      reasons.push(`get_market_tape listed leak-book names as flow: ${leaked.join(", ")}`);
    }
  }

  for (const row of input.tools) {
    if (row.tool_name !== "run_query" || !row.sql) continue;
    if (isUnfilteredOptionFlowSql(row.sql)) {
      reasons.push(`unfiltered option_contracts flow SQL: ${row.sql.replace(/\s+/g, " ").slice(0, 180)}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
