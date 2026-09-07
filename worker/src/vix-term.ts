/**
 * VIX term structure for GET /api/vix and the /vix page.
 *
 * Cash ^VIX is a calculated, non-tradable index. Tradable vol lives on CFE
 * VX monthals — especially the front two months. This module reads delayed
 * quotes (live curve) and official settlements (history / as-of replay).
 */
import { addCalendarDays, etDateKey } from "./timeline-session";
import {
  isMonthlyVxQuote,
  isMonthlyVxSettle,
  vxMonthLabel,
  vxSettlementToQuote,
} from "./vx-symbols";

export const VIX_TERM_HISTORY_DAYS = 90;
export const VIX_TERM_HISTORY_DATES = 40;
export const VIX_TERM_MAX_MONTHS = 12;

export const VIX_INDEX_SYMBOLS = {
  vix: "^VIX",
  vix9d: "^VIX9D",
  vix3m: "^VIX3M",
  vvix: "^VVIX",
} as const;

const VIX_INDEX_ORDER = [
  { key: "vix", symbol: "^VIX", name: "VIX" },
  { key: "vix9d", symbol: "^VIX9D", name: "VIX9D" },
  { key: "vix3m", symbol: "^VIX3M", name: "VIX3M" },
  { key: "vvix", symbol: "^VVIX", name: "VVIX" },
] as const;

export type VixCurveSource = "quotes" | "settlements";
export type VixCurveShape = "contango" | "backwardation" | "mixed" | "unknown";

export interface VixIndexPrint {
  symbol: string;
  name: string;
  last: number | null;
  prev: number | null;
  change_pct: number | null;
  date: string | null;
}

export interface VixIndexes {
  vix: VixIndexPrint;
  vix9d: VixIndexPrint;
  vix3m: VixIndexPrint;
  vvix: VixIndexPrint;
}

export interface VixCurvePoint {
  tenor: number;
  kind: "spot" | "future";
  symbol: string;
  label: string;
  last: number | null;
  prev: number | null;
  change: number | null;
  change_pct: number | null;
  expiration: string | null;
  dte: number | null;
  volume: number | null;
  open_interest: number | null;
  bid: number | null;
  ask: number | null;
  settle: number | null;
}

export interface VixMetrics {
  shape: VixCurveShape;
  m1_m2_pct: number | null;
  m1_m2_pts: number | null;
  m2_m3_pct: number | null;
  m4_m7_pct: number | null;
  vix_vs_m1_pct: number | null;
  vix_vs_vix3m_pct: number | null;
}

export interface VixHistoryCurve {
  date: string;
  points: VixCurvePoint[];
}

export interface VixTerm {
  as_of: string;
  source: VixCurveSource;
  indexes: VixIndexes;
  curve: VixCurvePoint[];
  metrics: VixMetrics;
  settlement_dates: string[];
  history: VixHistoryCurve[];
  fetched_at: string;
  errors: string[];
}

export type VixLakeQuery = (sql: string, key: string) => Promise<Record<string, unknown>[]>;

export interface VixTermDeps {
  queryLake: VixLakeQuery;
  asOfDate?: string;
  now?: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(raw: string | null | undefined): raw is string {
  if (!raw || !ISO_DATE.test(raw)) return false;
  const [year, month, day] = raw.split("-").map(Number);
  const utc = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  return (
    utc.getUTCFullYear() === year
    && utc.getUTCMonth() === (month ?? 1) - 1
    && utc.getUTCDate() === day
  );
}

export function resolveVixAsOf(asOfDate: string | undefined, today: string): string {
  if (asOfDate && isIsoDate(asOfDate) && asOfDate <= today) return asOfDate;
  return today;
}

function litDate(value: string): string {
  if (!isIsoDate(value)) throw new Error(`invalid date '${value}'`);
  return `'${value}'`;
}

export function vxQuotesSql(asOfDate: string): string {
  return (
    "WITH latest AS (\n" +
    "  SELECT contract_symbol, expiration_date, last, bid, ask, close, prev_close,\n" +
    "    volume, open_interest, settlement_price, as_of_date, fetched_at,\n" +
    "    ROW_NUMBER() OVER (\n" +
    "      PARTITION BY contract_symbol\n" +
    "      ORDER BY fetched_at DESC, run_id DESC\n" +
    "    ) AS rn\n" +
    "  FROM options.futures_quotes\n" +
    "  WHERE root = 'VX'\n" +
    "    AND expiration_date IS NOT NULL\n" +
    `    AND expiration_date >= ${litDate(asOfDate)}\n` +
    ")\n" +
    "SELECT contract_symbol, expiration_date, last, bid, ask, close, prev_close,\n" +
    "  volume, open_interest, settlement_price, as_of_date\n" +
    "FROM latest WHERE rn = 1\n" +
    "ORDER BY expiration_date ASC, contract_symbol ASC"
  );
}

export function vxSettlementsSql(since: string, asOfDate: string): string {
  return (
    "WITH latest AS (\n" +
    "  SELECT as_of_date, contract_symbol, expiration_date, settle_price,\n" +
    "    ROW_NUMBER() OVER (\n" +
    "      PARTITION BY as_of_date, contract_symbol\n" +
    "      ORDER BY fetched_at DESC, run_id DESC\n" +
    "    ) AS rn\n" +
    "  FROM options.futures_settlements\n" +
    "  WHERE product = 'VX'\n" +
    `    AND as_of_date >= ${litDate(since)}\n` +
    `    AND as_of_date <= ${litDate(asOfDate)}\n` +
    ")\n" +
    "SELECT as_of_date, contract_symbol, expiration_date, settle_price\n" +
    "FROM latest WHERE rn = 1"
  );
}

export function vixIndexSql(since: string, asOfDate: string): string {
  const symbols = Object.values(VIX_INDEX_SYMBOLS).map((s) => `'${s}'`).join(", ");
  return (
    "WITH latest_bars AS (\n" +
    "  SELECT symbol, date, close,\n" +
    "    ROW_NUMBER() OVER (PARTITION BY symbol, date ORDER BY fetched_at DESC, run_id DESC) AS drn\n" +
    "  FROM options.ohlc\n" +
    `  WHERE symbol IN (${symbols})\n` +
    `    AND date >= ${litDate(since)}\n` +
    `    AND date <= ${litDate(asOfDate)}\n` +
    "    AND close IS NOT NULL\n" +
    ")\n" +
    "SELECT symbol, date, close FROM latest_bars WHERE drn = 1"
  );
}

export function daysToExpiry(expiration: string | null, asOfDate: string): number | null {
  if (!expiration || !isIsoDate(expiration.slice(0, 10)) || !isIsoDate(asOfDate)) return null;
  const exp = Date.parse(`${expiration.slice(0, 10)}T00:00:00Z`);
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(exp) || !Number.isFinite(asOf)) return null;
  return Math.round((exp - asOf) / 86_400_000);
}

export function spreadPts(from: number | null, to: number | null): number | null {
  if (from == null || to == null) return null;
  return to - from;
}

export function spreadPct(from: number | null, to: number | null): number | null {
  if (from == null || to == null || from === 0) return null;
  return ((to - from) / from) * 100;
}

function numOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function strOrNull(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s ? s : null;
}

function isoDateOrNull(value: unknown): string | null {
  const s = String(value ?? "").trim().slice(0, 10);
  return isIsoDate(s) ? s : null;
}

function yearFromDate(date: string): number {
  return Number(date.slice(0, 4)) || 1970;
}

function emptyIndex(symbol: string, name: string): VixIndexPrint {
  return { symbol, name, last: null, prev: null, change_pct: null, date: null };
}

export function indexPrintFromRows(
  rows: Record<string, unknown>[],
  symbol: string,
  name: string,
  asOfDate: string,
): VixIndexPrint {
  const series = rows
    .map((row) => ({
      symbol: String(row.symbol ?? "").trim().toUpperCase(),
      date: isoDateOrNull(row.date),
      close: numOrNull(row.close ?? row.last ?? row.spot),
    }))
    .filter((row) => row.symbol === symbol && row.date && row.date <= asOfDate && row.close != null)
    .sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0));
  const last = series[0];
  const prev = series[1];
  return {
    symbol,
    name,
    last: last?.close ?? null,
    prev: prev?.close ?? null,
    change_pct: spreadPct(prev?.close ?? null, last?.close ?? null),
    date: last?.date ?? null,
  };
}

export function indexesFromOhlcRows(
  rows: Record<string, unknown>[],
  asOfDate: string,
): VixIndexes {
  const out = {} as VixIndexes;
  for (const item of VIX_INDEX_ORDER) {
    out[item.key] = indexPrintFromRows(rows, item.symbol, item.name, asOfDate);
  }
  return out;
}

function spotPoint(print: VixIndexPrint): VixCurvePoint {
  const last = print.last;
  const prev = print.prev;
  return {
    tenor: 0,
    kind: "spot",
    symbol: print.symbol,
    label: "Spot",
    last,
    prev,
    change: spreadPts(prev, last),
    change_pct: spreadPct(prev, last),
    expiration: null,
    dte: null,
    volume: null,
    open_interest: null,
    bid: null,
    ask: null,
    settle: null,
  };
}

function futurePoint(input: {
  tenor: number;
  symbol: string;
  last: number | null;
  prev: number | null;
  expiration: string | null;
  asOfDate: string;
  volume?: number | null;
  open_interest?: number | null;
  bid?: number | null;
  ask?: number | null;
  settle?: number | null;
}): VixCurvePoint {
  return {
    tenor: input.tenor,
    kind: "future",
    symbol: input.symbol,
    label: vxMonthLabel(input.symbol),
    last: input.last,
    prev: input.prev,
    change: spreadPts(input.prev, input.last),
    change_pct: spreadPct(input.prev, input.last),
    expiration: input.expiration,
    dte: daysToExpiry(input.expiration, input.asOfDate),
    volume: input.volume ?? null,
    open_interest: input.open_interest ?? null,
    bid: input.bid ?? null,
    ask: input.ask ?? null,
    settle: input.settle ?? null,
  };
}

export function curveFromQuoteRows(
  rows: Record<string, unknown>[],
  asOfDate: string,
  spot: VixIndexPrint,
): VixCurvePoint[] {
  const futures: VixCurvePoint[] = [];
  const seen = new Set<string>();
  const parsed = rows
    .map((row) => {
      const symbol = String(row.symbol ?? row.contract_symbol ?? "").trim().toUpperCase();
      return {
        symbol,
        expiration: isoDateOrNull(row.expiration_date ?? row.expiration),
        last: numOrNull(row.last ?? row.close ?? row.settlement_price),
        prev: numOrNull(row.prev_close),
        volume: numOrNull(row.volume),
        open_interest: numOrNull(row.open_interest),
        bid: numOrNull(row.bid),
        ask: numOrNull(row.ask),
        settle: numOrNull(row.settlement_price ?? row.settle),
      };
    })
    .filter((row) => isMonthlyVxQuote(row.symbol) && row.expiration && row.expiration >= asOfDate)
    .sort((a, b) => {
      if (a.expiration === b.expiration) return a.symbol < b.symbol ? -1 : 1;
      return a.expiration! < b.expiration! ? -1 : 1;
    });

  for (const row of parsed) {
    if (seen.has(row.symbol) || futures.length >= VIX_TERM_MAX_MONTHS) continue;
    seen.add(row.symbol);
    futures.push(futurePoint({
      tenor: futures.length + 1,
      symbol: row.symbol,
      last: row.last,
      prev: row.prev,
      expiration: row.expiration,
      asOfDate,
      volume: row.volume,
      open_interest: row.open_interest,
      bid: row.bid,
      ask: row.ask,
      settle: row.settle,
    }));
  }
  return [spotPoint(spot), ...futures];
}

interface SettleRow {
  date: string;
  symbol: string;
  expiration: string;
  settle: number | null;
}

export function parseMonthlySettleRows(
  rows: Record<string, unknown>[],
): SettleRow[] {
  const out: SettleRow[] = [];
  for (const row of rows) {
    const date = isoDateOrNull(row.as_of_date ?? row.date);
    const raw = String(row.contract_symbol ?? row.symbol ?? "").trim().toUpperCase();
    const expiration = isoDateOrNull(row.expiration_date ?? row.expiration);
    if (!date || !expiration || !isMonthlyVxSettle(raw)) continue;
    const symbol = vxSettlementToQuote(raw, yearFromDate(date));
    if (!symbol) continue;
    out.push({
      date,
      symbol,
      expiration,
      settle: numOrNull(row.settle_price ?? row.settle ?? row.last),
    });
  }
  return out;
}

export function curveFromSettleRows(
  rows: SettleRow[],
  asOfDate: string,
  spot: VixIndexPrint,
  prevBySymbol?: ReadonlyMap<string, number | null>,
): VixCurvePoint[] {
  const live = rows
    .filter((row) => row.date === asOfDate && row.expiration >= asOfDate)
    .sort((a, b) => {
      if (a.expiration === b.expiration) return a.symbol < b.symbol ? -1 : 1;
      return a.expiration < b.expiration ? -1 : 1;
    });
  const futures: VixCurvePoint[] = [];
  const seen = new Set<string>();
  for (const row of live) {
    if (seen.has(row.symbol) || futures.length >= VIX_TERM_MAX_MONTHS) continue;
    seen.add(row.symbol);
    futures.push(futurePoint({
      tenor: futures.length + 1,
      symbol: row.symbol,
      last: row.settle,
      prev: prevBySymbol?.get(row.symbol) ?? null,
      expiration: row.expiration,
      asOfDate,
      settle: row.settle,
    }));
  }
  return [spotPoint(spot), ...futures];
}

function prevSettlesBySymbol(
  rows: SettleRow[],
  previousDate: string | null,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!previousDate) return out;
  for (const row of rows) {
    if (row.date !== previousDate) continue;
    out.set(row.symbol, row.settle);
  }
  return out;
}

export function settlementDatesFromRows(rows: SettleRow[], asOfDate: string): string[] {
  const dates = [...new Set(rows.map((row) => row.date).filter((date) => date <= asOfDate))];
  dates.sort((a, b) => (a < b ? 1 : -1));
  return dates.slice(0, VIX_TERM_HISTORY_DATES);
}

export function computeVixMetrics(curve: VixCurvePoint[], indexes: VixIndexes): VixMetrics {
  const future = (tenor: number) => curve.find((p) => p.kind === "future" && p.tenor === tenor) ?? null;
  const m1 = future(1);
  const m2 = future(2);
  const m3 = future(3);
  const m4 = future(4);
  const m7 = future(7);
  const adjacent = curve
    .filter((p) => p.kind === "future")
    .sort((a, b) => a.tenor - b.tenor);
  let up = 0;
  let down = 0;
  for (let i = 1; i < adjacent.length; i++) {
    const left = adjacent[i - 1]!.last;
    const right = adjacent[i]!.last;
    if (left == null || right == null) continue;
    if (right > left) up += 1;
    else if (right < left) down += 1;
  }
  let shape: VixCurveShape = "unknown";
  if (up + down >= 2) {
    if (down === 0) shape = "contango";
    else if (up === 0) shape = "backwardation";
    else shape = "mixed";
  }
  return {
    shape,
    m1_m2_pct: spreadPct(m1?.last ?? null, m2?.last ?? null),
    m1_m2_pts: spreadPts(m1?.last ?? null, m2?.last ?? null),
    m2_m3_pct: spreadPct(m2?.last ?? null, m3?.last ?? null),
    m4_m7_pct: spreadPct(m4?.last ?? null, m7?.last ?? null),
    vix_vs_m1_pct: spreadPct(indexes.vix.last, m1?.last ?? null),
    vix_vs_vix3m_pct: spreadPct(indexes.vix.last, indexes.vix3m.last),
  };
}

function emptyIndexes(): VixIndexes {
  return {
    vix: emptyIndex("^VIX", "VIX"),
    vix9d: emptyIndex("^VIX9D", "VIX9D"),
    vix3m: emptyIndex("^VIX3M", "VIX3M"),
    vvix: emptyIndex("^VVIX", "VVIX"),
  };
}

export async function loadVixTerm(deps: VixTermDeps): Promise<VixTerm> {
  const now = deps.now ?? Date.now();
  const today = etDateKey(now);
  const asOf = resolveVixAsOf(deps.asOfDate, today);
  const historical = asOf < today;
  const since = addCalendarDays(asOf, -VIX_TERM_HISTORY_DAYS);
  const errors: string[] = [];

  const [quoteRows, settleRowsRaw, indexRows] = await Promise.all([
    historical
      ? Promise.resolve([] as Record<string, unknown>[])
      : deps.queryLake(vxQuotesSql(asOf), `vix_quotes_${asOf}`).catch((error) => {
        errors.push(`quotes: ${err(error)}`);
        return [] as Record<string, unknown>[];
      }),
    deps.queryLake(vxSettlementsSql(since, asOf), `vix_settle_${since}_${asOf}`).catch((error) => {
      errors.push(`settlements: ${err(error)}`);
      return [] as Record<string, unknown>[];
    }),
    deps.queryLake(vixIndexSql(since, asOf), `vix_idx_${since}_${asOf}`).catch((error) => {
      errors.push(`indexes: ${err(error)}`);
      return [] as Record<string, unknown>[];
    }),
  ]);

  const indexes = indexesFromOhlcRows(indexRows, asOf);
  const settleRows = parseMonthlySettleRows(settleRowsRaw);
  const settlementDates = settlementDatesFromRows(settleRows, asOf);
  const quoteCurve = curveFromQuoteRows(quoteRows, asOf, indexes.vix);
  const quoteHasFutures = quoteCurve.some((p) => p.kind === "future" && p.last != null);

  let source: VixCurveSource = "quotes";
  let curve: VixCurvePoint[] = quoteCurve;
  if (historical || !quoteHasFutures) {
    const settleAsOf = settlementDates.find((d) => d <= asOf) ?? asOf;
    const previous = settlementDates.find((d) => d < settleAsOf) ?? null;
    curve = curveFromSettleRows(
      settleRows,
      settleAsOf,
      indexesFromOhlcRows(indexRows, settleAsOf).vix,
      prevSettlesBySymbol(settleRows, previous),
    );
    source = "settlements";
  }

  const history: VixHistoryCurve[] = settlementDates.map((date, index) => {
    const previous = settlementDates[index + 1] ?? null;
    const spot = indexPrintFromRows(indexRows, "^VIX", "VIX", date);
    return {
      date,
      points: curveFromSettleRows(
        settleRows,
        date,
        spot,
        prevSettlesBySymbol(settleRows, previous),
      ),
    };
  });

  const metrics = computeVixMetrics(curve, source === "settlements"
    ? { ...indexes, vix: curve[0] ? { ...indexes.vix, last: curve[0].last, prev: curve[0].prev, change_pct: curve[0].change_pct } : indexes.vix }
    : indexes);

  if (curve.every((p) => p.last == null) && history.length === 0) {
    errors.push("no VX curve bars");
  }

  return {
    as_of: asOf,
    source,
    indexes: Object.keys(indexes).length ? indexes : emptyIndexes(),
    curve,
    metrics,
    settlement_dates: settlementDates,
    history,
    fetched_at: new Date(now).toISOString(),
    errors,
  };
}

function err(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
