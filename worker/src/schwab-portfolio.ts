/**
 * Charles Schwab Trader API — linked accounts, balances, positions.
 *
 * Base: https://api.schwabapi.com/trader/v1
 * Tokens never leave the Worker; responses are normalized (masked account
 * numbers, no hashValue).
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";

export const SCHWAB_TRADER_BASE = "https://api.schwabapi.com/trader/v1";

export interface SchwabPortfolioPosition {
  id: string;
  symbol: string;
  /** Option root / underlying when Schwab sends it (equity is null). */
  underlying: string | null;
  description: string | null;
  asset_type: string | null;
  quantity: number;
  average_price: number | null;
  market_value: number | null;
  day_pnl: number | null;
  open_pnl: number | null;
}

export interface SchwabPortfolioAccount {
  /** Stable opaque id for UI selection (not the Schwab hash). */
  id: string;
  account_number_masked: string;
  type: string | null;
  cash: number | null;
  equity: number | null;
  buying_power: number | null;
  day_pnl: number | null;
  open_pnl: number | null;
  positions: SchwabPortfolioPosition[];
}

export interface SchwabPortfolioTotals {
  cash: number;
  equity: number;
  buying_power: number;
  day_pnl: number;
  open_pnl: number;
  position_count: number;
  account_count: number;
}

export interface SchwabPortfolioView {
  connected: true;
  fetched_at: string;
  accounts: SchwabPortfolioAccount[];
  totals: SchwabPortfolioTotals;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

/** Mask account numbers for the browser — keep last 4 digits when present. */
export function maskAccountNumber(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length >= 4) return `••••${digits.slice(-4)}`;
  if ((raw ?? "").trim()) return "••••";
  return "Account";
}

function pickBalance(balances: Record<string, unknown> | null, keys: string[]): number | null {
  if (!balances) return null;
  for (const key of keys) {
    const n = num(balances[key]);
    if (n != null) return n;
  }
  return null;
}

function positionOpenPnl(pos: Record<string, unknown>): number | null {
  const long = num(pos.longOpenProfitLoss);
  const short = num(pos.shortOpenProfitLoss);
  if (long == null && short == null) return null;
  return (long ?? 0) + (short ?? 0);
}

function normalizePosition(
  pos: Record<string, unknown>,
  accountId: string,
  index: number,
): SchwabPortfolioPosition | null {
  const instrument = asRecord(pos.instrument) ?? {};
  const symbol =
    str(instrument.symbol) ??
    str(instrument.underlyingSymbol) ??
    str(instrument.description) ??
    "—";
  const longQty = num(pos.longQuantity) ?? 0;
  const shortQty = num(pos.shortQuantity) ?? 0;
  const quantity = longQty - shortQty;
  if (quantity === 0 && num(pos.marketValue) == null) return null;
  const avg =
    num(pos.averagePrice) ??
    num(pos.averageLongPrice) ??
    num(pos.averageShortPrice);
  return {
    id: `${accountId}:${symbol}:${index}`,
    symbol,
    underlying: str(instrument.underlyingSymbol),
    description: str(instrument.description),
    asset_type: str(instrument.assetType),
    quantity,
    average_price: avg,
    market_value: num(pos.marketValue),
    day_pnl: num(pos.currentDayProfitLoss),
    open_pnl: positionOpenPnl(pos),
  };
}

function securitiesAccount(entry: unknown): Record<string, unknown> | null {
  const root = asRecord(entry);
  if (!root) return null;
  return asRecord(root.securitiesAccount) ?? root;
}

/** Normalize raw Trader API account list into a safe portfolio view. */
export function normalizeSchwabAccounts(raw: unknown, now = Date.now()): SchwabPortfolioView {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const accounts: SchwabPortfolioAccount[] = [];

  for (let i = 0; i < list.length; i++) {
    const sec = securitiesAccount(list[i]);
    if (!sec) continue;
    const accountNumber = str(sec.accountNumber);
    const masked = maskAccountNumber(accountNumber);
    const id = `schwab-${i}-${masked.replace(/[•]/g, "").toLowerCase() || i}`;
    const balances = asRecord(sec.currentBalances);
    const type = str(sec.type) ?? str(sec.accountType);
    const cash = pickBalance(balances, [
      "cashBalance",
      "cashAvailableForTrading",
      "totalCash",
      "availableFunds",
    ]);
    const equity = pickBalance(balances, [
      "liquidationValue",
      "equity",
      "accountValue",
      "longMarketValue",
    ]);
    const buyingPower = pickBalance(balances, ["buyingPower", "availableFunds"]);

    const rawPositions = Array.isArray(sec.positions) ? sec.positions : [];
    const positions: SchwabPortfolioPosition[] = [];
    for (let j = 0; j < rawPositions.length; j++) {
      const p = asRecord(rawPositions[j]);
      if (!p) continue;
      const normalized = normalizePosition(p, id, j);
      if (normalized) positions.push(normalized);
    }

    let dayPnl = 0;
    let openPnl = 0;
    let hasDay = false;
    let hasOpen = false;
    for (const p of positions) {
      if (p.day_pnl != null) {
        dayPnl += p.day_pnl;
        hasDay = true;
      }
      if (p.open_pnl != null) {
        openPnl += p.open_pnl;
        hasOpen = true;
      }
    }

    accounts.push({
      id,
      account_number_masked: masked,
      type,
      cash,
      equity,
      buying_power: buyingPower,
      day_pnl: hasDay ? dayPnl : null,
      open_pnl: hasOpen ? openPnl : null,
      positions,
    });
  }

  const totals: SchwabPortfolioTotals = {
    cash: 0,
    equity: 0,
    buying_power: 0,
    day_pnl: 0,
    open_pnl: 0,
    position_count: 0,
    account_count: accounts.length,
  };
  for (const a of accounts) {
    if (a.cash != null) totals.cash += a.cash;
    if (a.equity != null) totals.equity += a.equity;
    if (a.buying_power != null) totals.buying_power += a.buying_power;
    if (a.day_pnl != null) totals.day_pnl += a.day_pnl;
    if (a.open_pnl != null) totals.open_pnl += a.open_pnl;
    totals.position_count += a.positions.length;
  }

  return {
    connected: true,
    fetched_at: new Date(now).toISOString(),
    accounts,
    totals,
  };
}

export class SchwabApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Schwab Trader API failed (${status}): ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function fetchSchwabAccountsRaw(
  accessToken: string,
  tokenType = "Bearer",
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${SCHWAB_TRADER_BASE}/accounts?fields=positions`;
  const resp = await fetchImpl(url, {
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
  return resp.json();
}

export type SchwabPortfolioResult =
  | { ok: true; view: SchwabPortfolioView }
  | { ok: false; reason: "not_connected" }
  | { ok: false; reason: "refresh_failed" | "upstream"; status: number; message: string };

export async function loadSchwabPortfolio(
  env: SchwabEnv,
  userId: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<SchwabPortfolioResult> {
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
    const raw = await fetchSchwabAccountsRaw(token.accessToken, token.tokenType, fetchImpl);
    return { ok: true, view: normalizeSchwabAccounts(raw, now) };
  } catch (e) {
    if (e instanceof SchwabApiError) {
      return {
        ok: false,
        reason: "upstream",
        status: e.status,
        message: e.message,
      };
    }
    return {
      ok: false,
      reason: "upstream",
      status: 502,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
