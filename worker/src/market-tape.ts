/**
 * First-class market tape for "what's going on" / hourly overview asks.
 *
 * Ad-hoc `GROUP BY symbol ORDER BY vol` on options.option_contracts is not
 * the tape: a thin ingest day (a handful of just-enrolled names) looks like
 * "unusual flow." This module always reads a fixed liquid sleeve — the same
 * indexes and sector ETFs the desk already talks about — and says so when
 * that day's option_contracts coverage is incomplete.
 */
import {
  highlightsFromOhlcRows,
  marketHighlightSql,
  type TimelineRailHighlight,
} from "./timeline-rail";

export const TAPE_INDEXES: ReadonlyArray<{ ticker: string; name: string }> = [
  { ticker: "SPY", name: "S&P 500" },
  { ticker: "QQQ", name: "Nasdaq-100" },
  { ticker: "IWM", name: "Russell 2000" },
  { ticker: "DIA", name: "Dow Jones" },
  { ticker: "^VIX", name: "VIX" },
];

export const TAPE_SECTORS: ReadonlyArray<{ ticker: string; name: string }> = [
  { ticker: "XLK", name: "Technology" },
  { ticker: "XLF", name: "Financials" },
  { ticker: "XLE", name: "Energy" },
  { ticker: "XLV", name: "Health Care" },
  { ticker: "XLI", name: "Industrials" },
  { ticker: "XLY", name: "Discretionary" },
  { ticker: "XLP", name: "Staples" },
  { ticker: "XLU", name: "Utilities" },
  { ticker: "XLB", name: "Materials" },
  { ticker: "XLRE", name: "Real Estate" },
  { ticker: "XLC", name: "Communication" },
];

/** Option-chain roots used for flow — no on-demand enrolled names. */
export const TAPE_FLOW_SYMBOLS: readonly string[] = [
  "SPY", "QQQ", "IWM", "DIA",
  "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC",
  "TLT", "HYG", "GLD", "SMH", "IBIT",
];

/** Distinct underlyings on one as_of_date below this = incomplete ingest. */
export const FLOW_COVERAGE_MIN_SYMBOLS = 40;

const HIGHLIGHT_LOOKBACK_DAYS = 14;

export type MarketTapeQuery = (sql: string) => Promise<Record<string, unknown>[]>;

export interface TapeFlowRow {
  symbol: string;
  type: string;
  vol: number;
  oi: number;
  iv: number | null;
}

export interface MarketTape {
  indexes: TimelineRailHighlight[];
  sectors: TimelineRailHighlight[];
  flow_as_of_date: string | null;
  flow_distinct_symbols: number | null;
  flow_complete: boolean;
  flow: TapeFlowRow[];
  errors: string[];
}

export function isMarketOverviewAsk(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return false;
  if (/\b(my|our)\s+(portfolio|book|positions?|holdings?)\b/.test(t)) return false;
  if (/what'?s going on with\s+[a-z0-9.^]{1,8}\b/.test(t) && !/\b(market|tape|session|indexes?|sectors?)\b/.test(t)) {
    return false;
  }
  if (/hourly market overview/.test(t)) return true;
  if (/market overview/.test(t)) return true;
  if (/live market commentary/.test(t)) return true;
  if (/what'?s happening (in the market|right now|now)\b/.test(t)) return true;
  if (/what is happening (in the market|right now)\b/.test(t)) return true;
  if (/what'?s going on\b/.test(t)) return true;
  if (/lead with (the )?(index|spx|spy\/qqq|spy\/qqq\/iwm)/.test(t)) return true;
  if (/\b(the tape|this session)\b/.test(t) && /\b(right now|today|session|market)\b/.test(t)) return true;
  return false;
}

export function tapeFlowSql(asOfDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error(`invalid as_of_date '${asOfDate}'`);
  }
  const symbols = TAPE_FLOW_SYMBOLS.map((s) => `'${s}'`).join(", ");
  return (
    "SELECT symbol, type, SUM(volume) AS vol, SUM(open_interest) AS oi, " +
    "AVG(implied_vol) AS iv\n" +
    "FROM options.option_contracts\n" +
    `WHERE as_of_date = '${asOfDate}'\n` +
    `  AND symbol IN (${symbols})\n` +
    "GROUP BY symbol, type\n" +
    "ORDER BY vol DESC\n" +
    "LIMIT 24"
  );
}

export function tapeCoverageSql(): string {
  return (
    "SELECT as_of_date, COUNT(DISTINCT symbol) AS n\n" +
    "FROM options.option_contracts\n" +
    "GROUP BY as_of_date\n" +
    "ORDER BY as_of_date DESC\n" +
    "LIMIT 1"
  );
}

export function parseTapeFlowRows(rows: Record<string, unknown>[]): TapeFlowRow[] {
  const out: TapeFlowRow[] = [];
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").trim().toUpperCase();
    const type = String(row.type ?? "").trim().toLowerCase();
    const vol = Number(row.vol ?? row.volume);
    const oi = Number(row.oi ?? row.open_interest);
    const iv = Number(row.iv ?? row.implied_vol);
    if (!symbol || !TAPE_FLOW_SYMBOLS.includes(symbol)) continue;
    if (type !== "call" && type !== "put") continue;
    out.push({
      symbol,
      type,
      vol: Number.isFinite(vol) ? vol : 0,
      oi: Number.isFinite(oi) ? oi : 0,
      iv: Number.isFinite(iv) ? iv : null,
    });
  }
  return out;
}

export function formatMarketTapeSummary(tape: MarketTape): string {
  const lines: string[] = [
    "Market tape (liquid sleeve — indexes, sector SPDRs, and listed flow on those names only).",
    "Ground the overview in this output. Do not invent flow leaders from an unfiltered option_contracts GROUP BY.",
    "",
    "Indexes:",
  ];
  for (const row of tape.indexes) {
    lines.push(`  ${fmtHighlight(row)}`);
  }
  lines.push("", "Sectors (1d):");
  const ranked = [...tape.sectors].sort((a, b) => {
    const ac = a.change_1d_pct ?? -Infinity;
    const bc = b.change_1d_pct ?? -Infinity;
    return bc - ac;
  });
  for (const row of ranked) {
    lines.push(`  ${fmtHighlight(row)}`);
  }
  lines.push("", "Options flow (liquid sleeve only):");
  if (!tape.flow_as_of_date) {
    lines.push("  No option_contracts as_of_date available.");
  } else {
    const n = tape.flow_distinct_symbols;
    const coverage = n == null ? "unknown coverage" : `${n} distinct underlyings that day`;
    if (tape.flow_complete) {
      lines.push(`  as_of_date ${tape.flow_as_of_date} (${coverage}).`);
    } else {
      lines.push(
        `  as_of_date ${tape.flow_as_of_date} (${coverage}) — incomplete ingest.`,
        "  Do not treat non-sleeve names that happen to be in that snapshot as unusual flow.",
      );
    }
    const withVol = tape.flow.filter((row) => row.vol > 0);
    if (withVol.length === 0) {
      lines.push("  No liquid-sleeve option volume on this as_of_date.");
    } else {
      for (const row of withVol.slice(0, 16)) {
        const iv = row.iv == null ? "" : ` iv=${row.iv.toFixed(3)}`;
        lines.push(`  ${row.symbol} ${row.type}  vol=${fmtNum(row.vol)}  oi=${fmtNum(row.oi)}${iv}`);
      }
    }
  }
  if (tape.errors.length) {
    lines.push("", `Notes: ${tape.errors.join("; ")}`);
  }
  return lines.join("\n");
}

export async function loadMarketTape(
  queryLake: MarketTapeQuery,
  now = Date.now(),
): Promise<MarketTape> {
  const since = new Date(now - HIGHLIGHT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const errors: string[] = [];
  const [indexRows, sectorRows, coverageRows] = await Promise.all([
    queryLake(marketHighlightSql(since, TAPE_INDEXES)).catch((error) => {
      errors.push(`indexes: ${err(error)}`);
      return [] as Record<string, unknown>[];
    }),
    queryLake(marketHighlightSql(since, TAPE_SECTORS)).catch((error) => {
      errors.push(`sectors: ${err(error)}`);
      return [] as Record<string, unknown>[];
    }),
    queryLake(tapeCoverageSql()).catch((error) => {
      errors.push(`coverage: ${err(error)}`);
      return [] as Record<string, unknown>[];
    }),
  ]);

  const asOf = coverageRows[0] ? String(coverageRows[0].as_of_date ?? "").slice(0, 10) : "";
  const distinct = coverageRows[0] ? Number(coverageRows[0].n) : NaN;
  let flow: TapeFlowRow[] = [];
  if (asOf) {
    try {
      flow = parseTapeFlowRows(await queryLake(tapeFlowSql(asOf)));
    } catch (error) {
      errors.push(`flow: ${err(error)}`);
    }
  }

  return {
    indexes: highlightsFromOhlcRows(indexRows, TAPE_INDEXES),
    sectors: highlightsFromOhlcRows(sectorRows, TAPE_SECTORS),
    flow_as_of_date: asOf || null,
    flow_distinct_symbols: Number.isFinite(distinct) ? distinct : null,
    flow_complete: Number.isFinite(distinct) && distinct >= FLOW_COVERAGE_MIN_SYMBOLS,
    flow,
    errors,
  };
}

function fmtHighlight(row: TimelineRailHighlight): string {
  const spot = row.spot == null ? "—" : row.spot.toFixed(2);
  const chg = row.change_1d_pct == null
    ? ""
    : `  ${row.change_1d_pct >= 0 ? "+" : ""}${row.change_1d_pct.toFixed(2)}%`;
  return `${row.ticker.padEnd(5)} ${row.name}  ${spot}${chg}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function err(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
