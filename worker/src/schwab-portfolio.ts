/**
 * Charles Schwab Trader API — linked accounts, balances, positions.
 *
 * Base: https://api.schwabapi.com/trader/v1
 * Tokens never leave the Worker; responses are normalized (masked account
 * numbers, no hashValue).
 */

import { getValidAccessToken, type SchwabEnv } from "./schwab";
import { kindFromSchwabAssetType } from "./symbol-identity";

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
  /** Schwab currentDayProfitLossPercentage, in percentage points. */
  day_pnl_pct?: number | null;
  open_pnl: number | null;
  cusip: string | null;
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
  day_pnl_pct?: number | null;
  open_pnl: number | null;
  positions: SchwabPortfolioPosition[];
}

export interface SchwabPortfolioTotals {
  cash: number;
  equity: number;
  buying_power: number;
  day_pnl: number;
  day_pnl_pct?: number | null;
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

/** P&L as a percent of the prior value. abs(start) keeps short losses negative. */
export function pnlPercent(pnl: number | null, equity: number | null): number | null {
  if (pnl == null || equity == null || !Number.isFinite(pnl) || !Number.isFinite(equity)) {
    return null;
  }
  const start = equity - pnl;
  if (!Number.isFinite(start) || start === 0) return null;
  return (pnl / Math.abs(start)) * 100;
}

function positionOpenPnl(pos: Record<string, unknown>): number | null {
  const long = num(pos.longOpenProfitLoss);
  const short = num(pos.shortOpenProfitLoss);
  if (long == null && short == null) return null;
  return (long ?? 0) + (short ?? 0);
}

/** Schwab's open P&L, or mark − cost when that field is omitted (common on ETFs). */
export function resolvePositionOpenPnl(
  pos: Record<string, unknown>,
  quantity: number,
  averagePrice: number | null,
  marketValue: number | null,
  assetType?: string | null,
): number | null {
  const reported = positionOpenPnl(pos);
  if (reported != null) return reported;
  if (averagePrice == null || marketValue == null) return null;
  const multiplier = (assetType ?? "").toUpperCase() === "OPTION" ? 100 : 1;
  return marketValue - averagePrice * quantity * multiplier;
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
    day_pnl_pct: num(pos.currentDayProfitLossPercentage)
      ?? pnlPercent(num(pos.currentDayProfitLoss), num(pos.marketValue)),
    open_pnl: resolvePositionOpenPnl(
      pos,
      quantity,
      avg,
      num(pos.marketValue),
      str(instrument.assetType),
    ),
    cusip: str(instrument.cusip),
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
    const balanceDayPnl = pickBalance(balances, ["currentDayProfitLoss"]);
    const balanceDayPnlPct = pickBalance(balances, ["currentDayProfitLossPercentage"]);

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

    const accountDayPnl = balanceDayPnl ?? (hasDay ? dayPnl : null);
    accounts.push({
      id,
      account_number_masked: masked,
      type,
      cash,
      equity,
      buying_power: buyingPower,
      day_pnl: accountDayPnl,
      day_pnl_pct: balanceDayPnlPct ?? pnlPercent(accountDayPnl, equity),
      open_pnl: hasOpen ? openPnl : null,
      positions,
    });
  }

  const totals: SchwabPortfolioTotals = {
    cash: 0,
    equity: 0,
    buying_power: 0,
    day_pnl: 0,
    day_pnl_pct: null,
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
  totals.day_pnl_pct = pnlPercent(totals.day_pnl, totals.equity);

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

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return value < 0 ? `-${formatted}` : formatted;
}

function pctLabel(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return "";
  const digits = Math.abs(pct) >= 10 ? 1 : 2;
  const abs = Math.abs(pct).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (pct > 0) return ` (+${abs}%)`;
  if (pct < 0) return ` (−${abs}%)`;
  return ` (${abs}%)`;
}

/** Compact tool summary for get_portfolio(source=schwab) — no account hashes. */
export function formatSchwabPortfolioSummary(view: SchwabPortfolioView): string {
  const { totals, accounts } = view;
  const lines = [
    "Schwab brokerage",
    `Cash ${money(totals.cash)} · Equity ${money(totals.equity)} · Buying power ${money(totals.buying_power)} · Day PnL ${money(totals.day_pnl)}${pctLabel(totals.day_pnl_pct)} · Open PnL ${money(totals.open_pnl)} · ${totals.position_count} positions across ${totals.account_count} account${totals.account_count === 1 ? "" : "s"}`,
  ];
  if (accounts.length === 0) {
    lines.push("No linked accounts returned.");
    return lines.join("\n");
  }
  let shown = 0;
  for (const account of accounts) {
    lines.push(
      `${account.account_number_masked}${account.type ? ` · ${account.type}` : ""} · cash ${money(account.cash)} · equity ${money(account.equity)}`,
    );
    for (const position of account.positions.slice(0, 40)) {
      shown += 1;
      if (shown > 40) break;
      const qty = Number.isFinite(position.quantity) ? String(position.quantity) : "—";
      const kind = kindFromSchwabAssetType(position.asset_type);
      const kindLabel = kind === "unknown" && position.asset_type
        ? position.asset_type.toLowerCase()
        : kind;
      lines.push(
        `- ${position.symbol}${position.underlying ? ` (${position.underlying})` : ""} · ${kindLabel}`
          + `${position.description ? ` · ${position.description}` : ""}`
          + ` · qty ${qty} · mark ${money(position.market_value)} · day ${money(position.day_pnl)}${pctLabel(position.day_pnl_pct)} · open ${money(position.open_pnl)}`,
      );
    }
    if (shown > 40) break;
  }
  if (totals.position_count > 40) lines.push(`…and ${totals.position_count - 40} more`);
  return lines.join("\n");
}

export function schwabAccountLabel(account: Pick<SchwabPortfolioAccount, "account_number_masked" | "type">): string {
  return account.type
    ? `Schwab · ${account.account_number_masked} · ${account.type}`
    : `Schwab · ${account.account_number_masked}`;
}

/** Scope a brokerage book to one or more linked accounts (recomputes totals). */
export function filterSchwabPortfolioView(
  view: SchwabPortfolioView,
  accountId?: string | string[] | null,
): SchwabPortfolioView {
  const ids = (Array.isArray(accountId) ? accountId : accountId != null ? [accountId] : [])
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return view;
  const wanted = new Set(ids);
  const accounts = view.accounts.filter((account) => wanted.has(account.id));
  let cash = 0;
  let equity = 0;
  let buying_power = 0;
  let day_pnl = 0;
  let open_pnl = 0;
  let position_count = 0;
  for (const account of accounts) {
    cash += account.cash ?? 0;
    equity += account.equity ?? 0;
    buying_power += account.buying_power ?? 0;
    day_pnl += account.day_pnl ?? 0;
    open_pnl += account.open_pnl ?? 0;
    position_count += account.positions.length;
  }
  return {
    ...view,
    accounts,
    totals: {
      cash,
      equity,
      buying_power,
      day_pnl,
      day_pnl_pct: pnlPercent(day_pnl, equity),
      open_pnl,
      position_count,
      account_count: accounts.length,
    },
  };
}

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
