/**
 * Charles Schwab Trader API — historical TRADE transactions.
 *
 * Uses the same token + account masking conventions as schwab-portfolio.ts.
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";
import {
  maskAccountNumber,
  SchwabApiError,
  SCHWAB_TRADER_BASE,
} from "./schwab-portfolio";

/** Schwab caps a single transactions query at ~1 year. */
export const SCHWAB_TRADES_MAX_RANGE_DAYS = 366;

export interface SchwabAccountNumber {
  accountNumber: string;
  hashValue: string;
}

/** Browser-safe account row (opaque id matches portfolio account ids). */
export interface SchwabTradeAccount {
  id: string;
  label: string;
  /** Encrypted hash for Trader API path — never sent to the browser. */
  hash: string;
}

export interface SchwabRawInstrument {
  assetType?: string;
  symbol?: string;
  cusip?: string;
  description?: string;
  underlyingSymbol?: string;
  putCall?: string;
  strikePrice?: number;
  expirationDate?: string;
  type?: string;
}

export interface SchwabRawTransferItem {
  instrument?: SchwabRawInstrument;
  amount?: number;
  cost?: number;
  price?: number;
  feeType?: string;
  positionEffect?: string;
}

export interface SchwabRawTransaction {
  activityId?: number;
  time?: string;
  description?: string;
  accountNumber?: string;
  type?: string;
  status?: string;
  subAccount?: string;
  tradeDate?: string;
  settlementDate?: string;
  positionId?: number;
  orderId?: number;
  netAmount?: number;
  activityType?: string;
  transferItems?: SchwabRawTransferItem[];
}

export type SchwabTradeSide = "buy" | "sell" | "unknown";

export interface SchwabTrade {
  id: string;
  activity_id: number | null;
  trade_date: string | null;
  settlement_date: string | null;
  description: string | null;
  status: string | null;
  activity_type: string | null;
  net_amount: number | null;
  symbol: string | null;
  underlying: string | null;
  asset_type: string | null;
  quantity: number | null;
  price: number | null;
  cost: number | null;
  fees: number | null;
  side: SchwabTradeSide;
  position_effect: string | null;
  order_id: number | null;
  position_id: number | null;
  /** CUSIP when Schwab sends it — used to join ETF dividends that omit symbol. */
  cusip: string | null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Same opaque id scheme as normalizeSchwabAccounts in schwab-portfolio. */
export function opaqueAccountId(index: number, accountNumber: string): string {
  const masked = maskAccountNumber(accountNumber);
  return `schwab-${index}-${masked.replace(/[•]/g, "").toLowerCase() || index}`;
}

export function toTradeAccounts(rows: SchwabAccountNumber[]): SchwabTradeAccount[] {
  const out: SchwabTradeAccount[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (typeof r.hashValue !== "string" || !r.hashValue) continue;
    const accountNumber = String(r.accountNumber ?? "");
    out.push({
      id: opaqueAccountId(i, accountNumber),
      label: maskAccountNumber(accountNumber),
      hash: r.hashValue,
    });
  }
  return out;
}

/** America/New_York calendar date as YYYY-MM-DD. */
export function etDateString(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Bucket a Schwab timestamp onto the ET trading calendar.
 * Date-only `YYYY-MM-DD` is returned as-is; ISO timestamps (including Schwab's
 * `+0000` offset form) convert through America/New_York so after-hours fills
 * stay on the session date the UI range labels use.
 */
export function etTradeDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  if (Number.isFinite(ms)) return etDateString(new Date(ms));
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : null;
}

function addCalendarDay(ymd: string): string {
  const ms = Date.parse(`${ymd}T12:00:00.000Z`);
  return new Date(ms + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** UTC instant of local midnight America/New_York on `ymd`. */
export function etMidnightUtc(ymd: string): Date {
  for (const offset of ["-04:00", "-05:00"] as const) {
    const candidate = new Date(`${ymd}T00:00:00.000${offset}`);
    if (!Number.isFinite(candidate.getTime())) continue;
    if (etDateString(candidate) !== ymd) continue;
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(candidate);
    if (hour === "00") return candidate;
  }
  return new Date(`${ymd}T04:00:00.000Z`);
}

/** Inclusive ET calendar-day bounds as UTC ISO instants for Schwab startDate/endDate. */
export function dayBoundsIso(startDate: string, endDate: string): { startIso: string; endIso: string } {
  const start = etMidnightUtc(startDate);
  const endExclusive = etMidnightUtc(addCalendarDay(endDate));
  return {
    startIso: start.toISOString(),
    endIso: new Date(endExclusive.getTime() - 1).toISOString(),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTradeDateRange(
  startRaw: string | null,
  endRaw: string | null,
  now = new Date(),
): { start: string; end: string } | { error: string } {
  const endDefault = now.toISOString().slice(0, 10);
  const startDefault = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const start = startRaw?.trim() || startDefault;
  const end = endRaw?.trim() || endDefault;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return { error: "start and end must be YYYY-MM-DD" };
  }
  if (start > end) return { error: "start must be on or before end" };

  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { error: "invalid start or end date" };
  }
  const days = Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  if (days > SCHWAB_TRADES_MAX_RANGE_DAYS) {
    return { error: `date range must be ≤ ${SCHWAB_TRADES_MAX_RANGE_DAYS} days (Schwab API limit)` };
  }
  return { start, end };
}

function isCurrencyItem(item: SchwabRawTransferItem): boolean {
  const asset = (item.instrument?.assetType ?? item.instrument?.type ?? "").toUpperCase();
  const sym = (item.instrument?.symbol ?? "").toUpperCase();
  if (item.feeType) return true;
  if (asset === "CURRENCY") return true;
  if (sym === "USD" || sym.startsWith("CURRENCY_")) return true;
  return false;
}

/**
 * Build a space-padded OCC equity-option symbol from instrument fields
 * (`SPY   260918P00500000`). Returns null when any field is incomplete.
 */
export function formatOccOptionSymbol(opts: {
  underlying: string;
  expiration: string;
  right: string;
  strike: number | null;
}): string | null {
  const root = opts.underlying.toUpperCase().replace(/\s+/g, "");
  if (!root || root.length > 6) return null;
  let exp = opts.expiration.trim().toUpperCase();
  if (/^\d{4}-\d{2}-\d{2}/.test(exp)) exp = exp.slice(2, 4) + exp.slice(5, 7) + exp.slice(8, 10);
  else exp = exp.replace(/-/g, "");
  if (!/^\d{6}$/.test(exp)) return null;
  const right = opts.right.trim().toUpperCase().slice(0, 1);
  if (right !== "C" && right !== "P") return null;
  if (opts.strike == null || !Number.isFinite(opts.strike) || opts.strike < 0) return null;
  const strikePart = String(Math.round(opts.strike * 1000)).padStart(8, "0");
  if (strikePart.length > 8) return null;
  return `${root.padEnd(6, " ")}${exp}${right}${strikePart}`;
}

/**
 * True when an activity belongs to `ticker` as equity or as an option on that
 * root. Exact match only — `CAR` does not include `CARD`. Schwab's
 * transactions `symbol=` query misses OCC option symbols, so callers fetch
 * unfiltered and apply this locally.
 */
export function matchesTicker(
  activity: { symbol?: string | null; underlying?: string | null },
  ticker: string | null | undefined,
): boolean {
  const want = ticker?.trim().toUpperCase();
  if (!want) return true;
  const underlying = activity.underlying?.trim().toUpperCase();
  if (underlying === want) return true;
  const symbol = activity.symbol?.trim().toUpperCase();
  if (!symbol) return false;
  if (symbol === want) return true;

  const compact = symbol.replace(/\s+/g, "");
  const occ = /^([A-Z0-9.\-]{1,6})\d{6}[CP]\d{8}$/.exec(compact);
  if (occ) return occ[1] === want;
  const readable =
    /^([A-Z0-9.\-]{1,6})\s+(\d{4}-\d{2}-\d{2})\s+(C|P|CALL|PUT)\b/.exec(symbol);
  return readable?.[1] === want;
}

function pickSecurityItem(items: SchwabRawTransferItem[]): SchwabRawTransferItem | null {
  // Prefer real securities — cash/CURRENCY legs also carry a symbol (CURRENCY_USD)
  // and must not win over the equity/option transfer item on the same TRADE.
  for (const item of items) {
    if (isCurrencyItem(item)) continue;
    if (item.instrument?.symbol || item.instrument?.underlyingSymbol) return item;
  }
  for (const item of items) {
    if (isCurrencyItem(item)) continue;
    if (item.instrument) return item;
  }
  return null;
}

function securityItems(items: SchwabRawTransferItem[]): SchwabRawTransferItem[] {
  return items.filter((item) => !isCurrencyItem(item) && Boolean(item.instrument));
}

/**
 * Commission P&L. Schwab `feeType` amounts are often the charged (positive)
 * figure on live trades; some payloads already send a signed debit. Always
 * return a drag (≤ 0) so Fees-only is commission cost, not a fake gain.
 */
export function commissionPnl(fees: number | null | undefined): number {
  if (fees == null || !Number.isFinite(fees) || fees === 0) return 0;
  return fees > 0 ? -fees : fees;
}

function sumFees(items: SchwabRawTransferItem[]): number | null {
  let total = 0;
  let any = false;
  for (const item of items) {
    if (!item.feeType) continue;
    const amt = asNumber(item.amount);
    if (amt == null) continue;
    total += amt;
    any = true;
  }
  return any ? commissionPnl(total) : null;
}

export function inferTradeSide(
  description: string | null | undefined,
  quantity: number | null,
  cost: number | null,
): SchwabTradeSide {
  const d = (description ?? "").toUpperCase();
  if (/\bBOUGHT\b|\bBUY\b/.test(d)) return "buy";
  if (/\bSOLD\b|\bSELL\b/.test(d)) return "sell";
  if (cost != null && cost < 0) return "buy";
  if (cost != null && cost > 0) return "sell";
  if (quantity != null && quantity > 0) return "buy";
  if (quantity != null && quantity < 0) return "sell";
  return "unknown";
}

function normalizeTradeLeg(
  tx: SchwabRawTransaction,
  security: SchwabRawTransferItem | null,
  legIndex: number,
  legCount: number,
  fees: number | null,
): SchwabTrade {
  const inst = security?.instrument;
  const quantity = asNumber(security?.amount);
  const price = asNumber(security?.price);
  const cost = asNumber(security?.cost);
  const activityId = asNumber(tx.activityId);
  const orderId = asNumber(tx.orderId);
  const positionId = asNumber(tx.positionId);

  let symbol = inst?.symbol?.trim() || null;
  const underlying = inst?.underlyingSymbol?.trim() || null;
  if (!symbol && underlying && inst?.assetType === "OPTION") {
    // Emit OCC so FIFO / assignment synth share one lot key with Schwab-native symbols.
    symbol = formatOccOptionSymbol({
      underlying,
      expiration: inst.expirationDate ?? "",
      right: inst.putCall ?? "",
      strike: asNumber(inst.strikePrice),
    });
  }

  const description = tx.description?.trim() || inst?.description?.trim() || null;
  // Complex executions can describe several opposing legs in one transaction.
  // For those, infer each side from its own signed cost/quantity rather than
  // applying the transaction-level prose to every leg.
  const side = inferTradeSide(legCount === 1 ? description : null, quantity, cost);
  const multiplier = (inst?.assetType ?? "").toUpperCase() === "OPTION" ? 100 : 1;
  const calculatedGross =
    cost ??
    (quantity != null && price != null
      ? -quantity * price * multiplier
      : null);
  const legNet =
    legCount === 1
      ? asNumber(tx.netAmount) ?? (calculatedGross != null ? calculatedGross + (fees ?? 0) : null)
      : calculatedGross != null
        ? calculatedGross + (fees ?? 0)
        : null;
  const baseId = activityId != null
    ? String(activityId)
    : `${tx.tradeDate ?? tx.time ?? "tx"}-${symbol ?? "x"}-${quantity ?? 0}`;

  return {
    id: legCount > 1 ? `${baseId}:leg:${legIndex}` : baseId,
    activity_id: activityId,
    trade_date: tx.tradeDate ?? tx.time ?? null,
    settlement_date: tx.settlementDate ?? null,
    description,
    status: tx.status ?? null,
    activity_type: tx.activityType ?? null,
    net_amount: legNet,
    symbol,
    underlying,
    asset_type: inst?.assetType ?? null,
    quantity,
    price,
    cost,
    fees,
    side,
    position_effect: security?.positionEffect ?? null,
    order_id: orderId,
    position_id: positionId,
    cusip: inst?.cusip?.trim() || null,
  };
}

/**
 * Normalize every security leg in a Schwab transaction. Complex option orders
 * share one activity id/net amount but carry per-leg cost and position effect;
 * collapsing them into one row corrupts both inventory and cash basis.
 */
export function normalizeTrades(tx: SchwabRawTransaction): SchwabTrade[] {
  const items = Array.isArray(tx.transferItems) ? tx.transferItems : [];
  const legs = securityItems(items);
  if (legs.length === 0) {
    return [normalizeTradeLeg(tx, pickSecurityItem(items), 0, 1, sumFees(items))];
  }

  const totalFees = sumFees(items);
  const weights = legs.map((leg) => Math.abs(asNumber(leg.amount) ?? 0));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  return legs.map((leg, index) => {
    const allocatedFees =
      totalFees == null
        ? null
        : weightTotal > 0
          ? totalFees * (weights[index]! / weightTotal)
          : totalFees / legs.length;
    return normalizeTradeLeg(tx, leg, index, legs.length, allocatedFees);
  });
}

/** Backward-compatible single-row helper for callers that expect one leg. */
export function normalizeTrade(tx: SchwabRawTransaction): SchwabTrade {
  return normalizeTrades(tx)[0]!;
}

/** Rows explicitly rejected/reversed by Schwab must never enter accounting. */
export function isIncludedSchwabTransaction(tx: SchwabRawTransaction): boolean {
  const status = (tx.status ?? "").trim().toUpperCase();
  return !["INVALID", "CANCELED", "CANCELLED", "REJECTED", "REVERSED"].includes(status);
}

async function schwabGet<T>(
  accessToken: string,
  path: string,
  query?: Record<string, string>,
  tokenType = "Bearer",
): Promise<T> {
  const url = new URL(`${SCHWAB_TRADER_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `${tokenType} ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new SchwabApiError(resp.status, text);
  }
  if (resp.status === 204) return [] as T;
  return (await resp.json()) as T;
}

export async function listSchwabAccountNumbers(
  accessToken: string,
  tokenType = "Bearer",
): Promise<SchwabAccountNumber[]> {
  const rows = await schwabGet<SchwabAccountNumber[]>(accessToken, "/accounts/accountNumbers", undefined, tokenType);
  return Array.isArray(rows) ? rows : [];
}

export async function listSchwabTransactions(
  accessToken: string,
  accountHash: string,
  opts: { start: string; end: string; types?: string; symbol?: string },
  tokenType = "Bearer",
): Promise<SchwabRawTransaction[]> {
  const { startIso, endIso } = dayBoundsIso(opts.start, opts.end);
  const query: Record<string, string> = {
    startDate: startIso,
    endDate: endIso,
    types: opts.types ?? "TRADE",
  };
  if (opts.symbol?.trim()) query.symbol = opts.symbol.trim().toUpperCase();

  const rows = await schwabGet<SchwabRawTransaction[]>(
    accessToken,
    `/accounts/${encodeURIComponent(accountHash)}/transactions`,
    query,
    tokenType,
  );
  return Array.isArray(rows) ? rows : [];
}

export const SCHWAB_TRANSACTIONS_PAGE_CAP = 3000;

export interface SchwabTransactionsPage {
  rows: SchwabRawTransaction[];
  /** A single ET day still hit Schwab's cap and cannot be split further. */
  truncated: boolean;
}

function dateMidpoint(start: string, end: string): string {
  const startMs = Date.parse(`${start}T12:00:00.000Z`);
  const endMs = Date.parse(`${end}T12:00:00.000Z`);
  const days = Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000));
  return new Date(startMs + Math.floor(days / 2) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Fetch a complete transaction window by bisecting capped responses. Schwab
 * exposes no cursor for this endpoint; non-overlapping date partitions avoid
 * silently calculating from the first ~3000 rows.
 */
export async function listSchwabTransactionsComplete(
  accessToken: string,
  accountHash: string,
  opts: { start: string; end: string; types?: string; symbol?: string },
  tokenType = "Bearer",
): Promise<SchwabTransactionsPage> {
  const load = async (start: string, end: string): Promise<SchwabTransactionsPage> => {
    const rows = await listSchwabTransactions(
      accessToken,
      accountHash,
      { ...opts, start, end },
      tokenType,
    );
    if (rows.length < SCHWAB_TRANSACTIONS_PAGE_CAP) {
      return { rows, truncated: false };
    }
    if (start === end) return { rows, truncated: true };

    const midpoint = dateMidpoint(start, end);
    const rightStart = addCalendarDay(midpoint);
    const [left, right] = await Promise.all([
      load(start, midpoint),
      load(rightStart, end),
    ]);
    return {
      rows: [...left.rows, ...right.rows],
      truncated: left.truncated || right.truncated,
    };
  };

  return load(opts.start, opts.end);
}

export interface SchwabTradesView {
  accounts: Array<{ id: string; label: string }>;
  account: string | null;
  start: string;
  end: string;
  symbol: string | null;
  trades: SchwabTrade[];
  may_be_truncated: boolean;
}

export type SchwabTradesResult =
  | { ok: true; view: SchwabTradesView }
  | { ok: false; reason: "not_connected" }
  | { ok: false; reason: "bad_request"; message: string }
  | { ok: false; reason: "refresh_failed" | "upstream"; status: number; message: string };

export async function loadSchwabTrades(
  env: SchwabEnv,
  userId: string,
  opts: {
    start: string;
    end: string;
    accountId?: string | null;
    symbol?: string | null;
    /** Schwab transactions `types` query (default TRADE). */
    types?: string | null;
  },
  now = Date.now(),
): Promise<SchwabTradesResult> {
  let token: { accessToken: string; tokenType: string } | null;
  try {
    token = await getValidAccessToken(env, userId, now);
  } catch (e) {
    return {
      ok: false,
      reason: "refresh_failed",
      status: 401,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!token) return { ok: false, reason: "not_connected" };

  try {
    const accounts = toTradeAccounts(await listSchwabAccountNumbers(token.accessToken, token.tokenType));
    const publicAccounts = accounts.map((a) => ({ id: a.id, label: a.label }));
    if (accounts.length === 0) {
      return {
        ok: true,
        view: {
          accounts: [],
          account: null,
          start: opts.start,
          end: opts.end,
          symbol: opts.symbol?.trim().toUpperCase() || null,
          trades: [],
          may_be_truncated: false,
        },
      };
    }

    let selected = accounts[0]!;
    if (opts.accountId?.trim()) {
      const match = accounts.find((a) => a.id === opts.accountId!.trim());
      if (!match) return { ok: false, reason: "bad_request", message: "unknown Schwab account" };
      selected = match;
    }

    const ticker = opts.symbol?.trim().toUpperCase() || null;
    const page = await listSchwabTransactionsComplete(
      token.accessToken,
      selected.hash,
      {
        start: opts.start,
        end: opts.end,
        types: opts.types?.trim() || "TRADE",
        // Never forward symbol= — Schwab misses OCC option rows for the root.
      },
      token.tokenType,
    );
    const trades = page.rows
      .filter(isIncludedSchwabTransaction)
      .flatMap(normalizeTrades)
      .filter((t) => matchesTicker(t, ticker))
      .sort((a, b) => {
        const ta = a.trade_date ?? "";
        const tb = b.trade_date ?? "";
        return tb.localeCompare(ta);
      });

    return {
      ok: true,
      view: {
        accounts: publicAccounts,
        account: selected.id,
        start: opts.start,
        end: opts.end,
        symbol: opts.symbol?.trim().toUpperCase() || null,
        trades,
        may_be_truncated: page.truncated,
      },
    };
  } catch (e) {
    if (e instanceof SchwabApiError) {
      return { ok: false, reason: "upstream", status: e.status, message: e.message };
    }
    return {
      ok: false,
      reason: "upstream",
      status: 502,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
