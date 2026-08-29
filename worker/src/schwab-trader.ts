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

/** YYYY-MM-DD → UTC day bounds for Schwab startDate/endDate. */
export function dayBoundsIso(startDate: string, endDate: string): { startIso: string; endIso: string } {
  return {
    startIso: `${startDate}T00:00:00.000Z`,
    endIso: `${endDate}T23:59:59.999Z`,
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

function pickSecurityItem(items: SchwabRawTransferItem[]): SchwabRawTransferItem | null {
  for (const item of items) {
    if (item.instrument?.symbol || item.instrument?.underlyingSymbol) return item;
  }
  for (const item of items) {
    if (item.instrument) return item;
  }
  return null;
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
  return any ? total : null;
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

export function normalizeTrade(tx: SchwabRawTransaction): SchwabTrade {
  const items = Array.isArray(tx.transferItems) ? tx.transferItems : [];
  const security = pickSecurityItem(items);
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
    const right = (inst.putCall ?? "").slice(0, 1).toUpperCase();
    const strike = asNumber(inst.strikePrice);
    const exp = inst.expirationDate?.slice(0, 10) ?? "";
    symbol = [underlying, exp, right || null, strike != null ? String(strike) : null]
      .filter(Boolean)
      .join(" ");
  }

  const description = tx.description ?? null;
  const side = inferTradeSide(description, quantity, cost);

  return {
    id: activityId != null
      ? String(activityId)
      : `${tx.tradeDate ?? tx.time ?? "tx"}-${symbol ?? "x"}-${quantity ?? 0}`,
    activity_id: activityId,
    trade_date: tx.tradeDate ?? tx.time ?? null,
    settlement_date: tx.settlementDate ?? null,
    description,
    status: tx.status ?? null,
    activity_type: tx.activityType ?? null,
    net_amount: asNumber(tx.netAmount),
    symbol,
    underlying,
    asset_type: inst?.assetType ?? null,
    quantity,
    price,
    cost,
    fees: sumFees(items),
    side,
    position_effect: security?.positionEffect ?? null,
    order_id: orderId,
    position_id: positionId,
  };
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
  opts: { start: string; end: string; accountId?: string | null; symbol?: string | null },
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

    const raw = await listSchwabTransactions(
      token.accessToken,
      selected.hash,
      {
        start: opts.start,
        end: opts.end,
        types: "TRADE",
        symbol: opts.symbol ?? undefined,
      },
      token.tokenType,
    );
    const trades = raw.map(normalizeTrade).sort((a, b) => {
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
        may_be_truncated: trades.length >= 3000,
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
