/**
 * Paper portfolio — track Copilot suggested trades with entry/mark PnL.
 *
 * Suggestions alone are not a book (copilot_tool_events is ~30d debug).
 * Tracking snapshots legs into D1, marks against the lake (spot / option mid),
 * and maintains one cash account per signed-in user. Daily mark history
 * (position_mark_history + hourly cron) keeps day-over-day PnL durable.
 */

import type { TradeLeg, SuggestedTrade, SuggestedTrades } from "./copilot-trades";
import { formatTradeLeg, normalizeSuggestedTrades } from "./copilot-trades";
import { recordDailyMarkSafe } from "./position-mark-history";

export const DEFAULT_STARTING_CASH_CENTS = 100_000_00; // $100,000.00
export const OPTION_MULTIPLIER = 100;
export const MAX_STRUCTURE_QTY = 1_000;

export type LakeSql = (sql: string, key?: string) => Promise<Record<string, unknown>[]>;

export type PaperPositionStatus = "open" | "closed";
export type PaperPositionSource = "suggestion" | "manual";
export type TradeConviction = "high" | "medium" | "low";

/** Parse conviction query/tool input; null means no filter. */
export function parseConviction(raw: string | null | undefined): TradeConviction | null {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return null;
}

export interface PaperAccount {
  user_id: string;
  cash_cents: number;
  starting_cash_cents: number;
  created_at: number;
  updated_at: number;
}

export interface PaperPositionRow {
  id: string;
  user_id: string;
  status: PaperPositionStatus;
  source: PaperPositionSource;
  chat_id: string | null;
  suggestion_key: string | null;
  ticker: string;
  bias: string | null;
  conviction: string | null;
  structure: string;
  rationale: string | null;
  liquidity: string | null;
  legs_json: string;
  qty: number;
  entry_value: number | null;
  entry_marked_at: number | null;
  mark_value: number | null;
  marked_at: number | null;
  realized_pnl: number | null;
  opened_at: number;
  closed_at: number | null;
}

export interface LegMark {
  instrument: "option" | "equity";
  side: "buy" | "sell";
  qty: number;
  symbol: string;
  right?: "call" | "put";
  strike?: number;
  expiration?: string;
  /** Per-unit mid used for MTM (option premium or equity last). */
  mid: number | null;
  /** Signed contribution to structure value (buy +, sell −) × qty × multiplier. */
  value: number | null;
  error?: string;
}

export interface StructureMark {
  legs: LegMark[];
  /** Net structure value for one unit (options use ×100). Null if any leg unpriced. */
  value: number | null;
  marked_at: number;
  incomplete: boolean;
}

export interface PaperPositionView {
  id: string;
  status: PaperPositionStatus;
  source: PaperPositionSource;
  chat_id: string | null;
  suggestion_key: string | null;
  ticker: string;
  bias: string | null;
  conviction: string | null;
  structure: string;
  rationale: string | null;
  liquidity: string | null;
  legs: TradeLeg[];
  qty: number;
  entry_value: number | null;
  entry_marked_at: number | null;
  mark_value: number | null;
  marked_at: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  opened_at: number;
  opened_at_iso: string;
  closed_at: number | null;
  closed_at_iso: string | null;
}

export interface PaperPortfolioView {
  account: {
    cash: number;
    starting_cash: number;
    equity: number;
    open_pnl: number;
    realized_pnl: number;
    created_at: number;
    updated_at: number;
  };
  positions: PaperPositionView[];
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `${prefix}_${out}`;
}

function iso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** Mid from bid/ask/last — prefer two-sided quote, else last. */
export function quoteMid(bid: number | null, ask: number | null, last: number | null): number | null {
  if (bid != null && ask != null && bid > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  if (last != null && last > 0) return last;
  if (bid != null && bid > 0) return bid;
  if (ask != null && ask > 0) return ask;
  return null;
}

function resolveInstrument(leg: TradeLeg): "option" | "equity" | "unsupported" {
  if (leg.instrument === "kalshi") return "unsupported";
  if (leg.instrument === "option" || leg.instrument === "equity") return leg.instrument;
  const rec = leg as TradeLeg & { right?: string; strike?: number; strike_rel?: string; market_ticker?: string };
  if (rec.market_ticker) return "unsupported";
  if (rec.right || rec.strike != null || rec.strike_rel) return "option";
  return "equity";
}

function legQty(leg: TradeLeg): number {
  return leg.qty != null && Number.isFinite(leg.qty) && leg.qty > 0 ? Math.floor(leg.qty) : 1;
}

function sideSign(side: "buy" | "sell"): number {
  return side === "buy" ? 1 : -1;
}

/**
 * Signed MTM contribution for one leg (one structure unit already applied via leg.qty).
 * Options: mid × 100 × qty × sign. Equity: mid × qty × sign.
 */
export function legSignedValue(
  instrument: "option" | "equity",
  side: "buy" | "sell",
  qty: number,
  mid: number | null,
): number | null {
  if (mid == null || !Number.isFinite(mid)) return null;
  const mult = instrument === "option" ? OPTION_MULTIPLIER : 1;
  return sideSign(side) * mid * qty * mult;
}

/** Net structure value across legs for `structureQty` packages. */
export function structureNetValue(legValues: Array<number | null>, structureQty: number): number | null {
  if (legValues.some((v) => v == null)) return null;
  const unit = (legValues as number[]).reduce((sum, v) => sum + v, 0);
  return unit * structureQty;
}

export function unrealizedPnl(entryValue: number | null, markValue: number | null): number | null {
  if (entryValue == null || markValue == null) return null;
  return markValue - entryValue;
}

const LATEST_UNDERLYING =
  "SELECT ticker AS symbol, name, sector, spot_price, run_id, fetched_at " +
  "FROM options.underlying_snapshots " +
  "QUALIFY ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY fetched_at DESC) = 1";

export async function ensurePaperAccount(
  db: D1Database,
  userId: string,
  now = Date.now(),
  startingCashCents = DEFAULT_STARTING_CASH_CENTS,
): Promise<PaperAccount> {
  const existing = await db.prepare(
    `SELECT user_id, cash_cents, starting_cash_cents, created_at, updated_at
     FROM paper_accounts WHERE user_id = ?1`,
  ).bind(userId).first<PaperAccount>();
  if (existing) return existing;

  await db.prepare(
    `INSERT INTO paper_accounts (user_id, cash_cents, starting_cash_cents, created_at, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?3)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(userId, startingCashCents, now).run();

  const row = await db.prepare(
    `SELECT user_id, cash_cents, starting_cash_cents, created_at, updated_at
     FROM paper_accounts WHERE user_id = ?1`,
  ).bind(userId).first<PaperAccount>();
  if (!row) throw new Error("failed to create paper account");
  return row;
}

function parseLegsJson(raw: string): TradeLeg[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TradeLeg[];
  } catch {
    return [];
  }
}

function rowToView(row: PaperPositionRow): PaperPositionView {
  const entry = row.entry_value;
  const mark = row.mark_value;
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    chat_id: row.chat_id,
    suggestion_key: row.suggestion_key,
    ticker: row.ticker,
    bias: row.bias,
    conviction: row.conviction,
    structure: row.structure,
    rationale: row.rationale,
    liquidity: row.liquidity,
    legs: parseLegsJson(row.legs_json),
    qty: row.qty,
    entry_value: entry,
    entry_marked_at: row.entry_marked_at,
    mark_value: mark,
    marked_at: row.marked_at,
    unrealized_pnl: row.status === "open" ? unrealizedPnl(entry, mark) : null,
    realized_pnl: row.realized_pnl,
    opened_at: row.opened_at,
    opened_at_iso: iso(row.opened_at)!,
    closed_at: row.closed_at,
    closed_at_iso: iso(row.closed_at),
  };
}

async function fetchSpotMap(lake: LakeSql, symbols: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean))];
  const out = new Map<string, number>();
  if (unique.length === 0) return out;
  const inList = unique.map(lit).join(", ");
  const rows = await lake(
    `SELECT symbol, spot_price FROM (${LATEST_UNDERLYING}) WHERE symbol IN (${inList})`,
    `paper_spot_${unique.slice().sort().join("_").slice(0, 64)}`,
  );
  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    const spot = numOrNull(r.spot_price);
    if (sym && spot != null && spot > 0) out.set(sym, spot);
  }
  return out;
}

type OptionKey = string;

function optionKey(symbol: string, right: string, strike: number, expiration: string): OptionKey {
  return `${symbol}|${right}|${strike}|${expiration}`;
}

async function fetchOptionMids(
  lake: LakeSql,
  keys: Array<{ symbol: string; right: string; strike: number; expiration: string }>,
): Promise<Map<OptionKey, number>> {
  const out = new Map<OptionKey, number>();
  if (keys.length === 0) return out;

  // Batch by underlying to keep SQL bounded.
  const bySymbol = new Map<string, typeof keys>();
  for (const k of keys) {
    const list = bySymbol.get(k.symbol) ?? [];
    list.push(k);
    bySymbol.set(k.symbol, list);
  }

  for (const [symbol, group] of bySymbol) {
    const expirations = [...new Set(group.map((g) => g.expiration))];
    const expList = expirations.map(lit).join(", ");
    const rows = await lake(
      `SELECT type, strike, expiration, bid, ask, last
       FROM options.option_contracts
       WHERE symbol = ${lit(symbol)} AND expiration IN (${expList})
       QUALIFY ROW_NUMBER() OVER (
         PARTITION BY type, strike, expiration
         ORDER BY fetched_at DESC, run_id DESC
       ) = 1`,
      `paper_opt_${symbol}_${expirations.join("_").slice(0, 40)}`,
    );
    for (const r of rows) {
      const right = String(r.type ?? "").toLowerCase();
      const strike = numOrNull(r.strike);
      const expiration = String(r.expiration ?? "");
      if ((right !== "call" && right !== "put") || strike == null || !expiration) continue;
      const mid = quoteMid(numOrNull(r.bid), numOrNull(r.ask), numOrNull(r.last));
      if (mid == null) continue;
      out.set(optionKey(symbol, right, strike, expiration), mid);
    }
  }
  return out;
}

/**
 * Mark a structure against lake quotes. Option legs need absolute strike +
 * expiration + right; strike_rel-only legs cannot be marked.
 */
export async function markStructure(
  lake: LakeSql,
  ticker: string,
  legs: TradeLeg[],
  structureQty = 1,
  now = Date.now(),
): Promise<StructureMark> {
  const parent = ticker.trim().toUpperCase();
  const equitySymbols: string[] = [];
  const optionLookups: Array<{ symbol: string; right: string; strike: number; expiration: string; index: number }> = [];

  const prepared = legs.map((leg, index) => {
    const instrument = resolveInstrument(leg);
    const symbol = (leg.symbol ?? parent).toUpperCase();
    const qty = legQty(leg);
    if (instrument === "unsupported") {
      return {
        index,
        instrument: "option" as const,
        side: leg.side,
        qty,
        symbol,
        error: "kalshi legs cannot be marked in the paper book yet",
      } as const;
    }
    if (instrument === "equity") {
      equitySymbols.push(symbol);
      return { index, instrument: "equity" as const, side: leg.side, qty, symbol } as const;
    }
    const right = "right" in leg ? leg.right : undefined;
    const strike = "strike" in leg ? leg.strike : undefined;
    const expiration = "expiration" in leg ? leg.expiration : undefined;
    if (!right || strike == null || !expiration) {
      return {
        index,
        instrument: "option" as const,
        side: leg.side,
        qty,
        symbol,
        right,
        strike: strike ?? undefined,
        expiration: expiration ?? undefined,
        error: "option leg needs right, absolute strike, and expiration to mark",
      } as const;
    }
    optionLookups.push({ symbol, right, strike, expiration, index });
    return {
      index,
      instrument: "option" as const,
      side: leg.side,
      qty,
      symbol,
      right,
      strike,
      expiration,
    } as const;
  });

  const [spots, optionMids] = await Promise.all([
    fetchSpotMap(lake, equitySymbols.length ? equitySymbols : [parent]),
    fetchOptionMids(lake, optionLookups),
  ]);

  const legMarks: LegMark[] = prepared.map((p) => {
    if ("error" in p && p.error) {
      return {
        instrument: p.instrument,
        side: p.side,
        qty: p.qty,
        symbol: p.symbol,
        right: p.right,
        strike: p.strike,
        expiration: p.expiration,
        mid: null,
        value: null,
        error: p.error,
      };
    }
    if (p.instrument === "equity") {
      const mid = spots.get(p.symbol) ?? null;
      return {
        instrument: "equity",
        side: p.side,
        qty: p.qty,
        symbol: p.symbol,
        mid,
        value: legSignedValue("equity", p.side, p.qty, mid),
        error: mid == null ? "no spot for underlying" : undefined,
      };
    }
    const mid = optionMids.get(optionKey(p.symbol, p.right!, p.strike!, p.expiration!)) ?? null;
    return {
      instrument: "option",
      side: p.side,
      qty: p.qty,
      symbol: p.symbol,
      right: p.right,
      strike: p.strike,
      expiration: p.expiration,
      mid,
      value: legSignedValue("option", p.side, p.qty, mid),
      error: mid == null ? "no quote for option contract" : undefined,
    };
  });

  const values = legMarks.map((m) => m.value);
  const value = structureNetValue(values, structureQty);
  return {
    legs: legMarks,
    value,
    marked_at: now,
    incomplete: value == null,
  };
}

export function suggestionKey(chatId: string | null | undefined, tradeIndex: number, trade: SuggestedTrade): string {
  const legs = (trade.legs ?? [])
    .map((l) => {
      const inst = resolveInstrument(l);
      if (inst === "equity") return `e:${l.side}:${legQty(l)}:${l.symbol ?? trade.ticker}`;
      const right = "right" in l ? l.right : "";
      const strike = "strike" in l ? l.strike : undefined;
      const strikeRel = "strike_rel" in l ? l.strike_rel : undefined;
      const expiration = "expiration" in l ? l.expiration : undefined;
      const dte = "dte" in l ? l.dte : undefined;
      return `o:${l.side}:${legQty(l)}:${l.symbol ?? trade.ticker}:${right ?? ""}:${strike ?? strikeRel ?? ""}:${expiration ?? dte ?? ""}`;
    })
    .join("|");
  const base = `${(chatId ?? "anon").slice(0, 64)}:${tradeIndex}:${trade.ticker}:${trade.structure}:${legs}`;
  // Stable short key — FNV-1a hex of the fingerprint.
  let h = 0x811c9dc5;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `sug_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export interface TrackSuggestionInput {
  trade: SuggestedTrade;
  trade_index?: number;
  chat_id?: string | null;
  qty?: number;
}

export type TrackResult =
  | { ok: true; position: PaperPositionView; account_cash: number; created: boolean }
  | { ok: false; error: string; status: number };

export interface AutoTrackResult {
  /** Chat has no signed-in owner (anonymous / bot) — nothing to apply. */
  skipped: "no_owner" | "empty" | null;
  tracked: number;
  already: number;
  failed: number;
  errors: string[];
}

/**
 * Apply every markable suggested trade into the chat owner's paper book.
 * Used when suggest_trades succeeds — suggestions are not fire-and-forget.
 *
 * When the chat is not yet cataloged but `userId` is known (session on the
 * agent request), claim it from the first user turn title then open positions.
 */
export async function autoTrackSuggestedTrades(
  db: D1Database,
  lake: LakeSql,
  chatId: string,
  payload: SuggestedTrades,
  opts?: { userId?: string | null; title?: string | null; now?: number },
): Promise<AutoTrackResult> {
  const now = opts?.now ?? Date.now();
  const trades = payload.trades ?? [];
  if (trades.length === 0) {
    return { skipped: "empty", tracked: 0, already: 0, failed: 0, errors: [] };
  }

  let owner = await db.prepare(
    `SELECT user_id, deleted_at FROM user_chats WHERE chat_id = ?1`,
  ).bind(chatId).first<{ user_id: string; deleted_at: number | null }>();

  if ((!owner || owner.deleted_at != null) && opts?.userId) {
    const title = typeof opts.title === "string" && opts.title.trim()
      ? opts.title.trim().slice(0, 120)
      : "Chat";
    try {
      await db.prepare(
        `INSERT INTO user_chats (chat_id, user_id, title, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?4, NULL)
         ON CONFLICT(chat_id) DO NOTHING`,
      ).bind(chatId, opts.userId, title, now).run();
    } catch {
      // Concurrent claim — re-read owner below.
    }
    owner = await db.prepare(
      `SELECT user_id, deleted_at FROM user_chats WHERE chat_id = ?1`,
    ).bind(chatId).first<{ user_id: string; deleted_at: number | null }>();
  }

  if (!owner || owner.deleted_at != null) {
    return { skipped: "no_owner", tracked: 0, already: 0, failed: 0, errors: [] };
  }
  // Never apply into someone else's book if a session hint disagrees.
  if (opts?.userId && owner.user_id !== opts.userId) {
    return { skipped: "no_owner", tracked: 0, already: 0, failed: 0, errors: [] };
  }

  let tracked = 0;
  let already = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!;
    const result = await trackSuggestion(db, lake, owner.user_id, {
      trade,
      trade_index: i,
      chat_id: chatId,
      qty: 1,
    }, now);
    if (!result.ok) {
      failed += 1;
      errors.push(`${trade.ticker}: ${result.error}`);
      continue;
    }
    if (result.created) tracked += 1;
    else already += 1;
  }

  return { skipped: null, tracked, already, failed, errors };
}

export async function trackSuggestion(
  db: D1Database,
  lake: LakeSql,
  userId: string,
  input: TrackSuggestionInput,
  now = Date.now(),
): Promise<TrackResult> {
  const normalized = normalizeSuggestedTrades({ trades: [input.trade] });
  const trade = normalized?.trades[0];
  if (!trade) return { ok: false, error: "invalid trade", status: 400 };
  if (!trade.legs?.length) {
    return { ok: false, error: "trade needs concrete legs to track PnL", status: 400 };
  }

  const qtyRaw = input.qty ?? 1;
  if (!Number.isFinite(qtyRaw) || qtyRaw < 1 || qtyRaw > MAX_STRUCTURE_QTY) {
    return { ok: false, error: `qty must be 1–${MAX_STRUCTURE_QTY}`, status: 400 };
  }
  const qty = Math.floor(qtyRaw);
  const chatId = typeof input.chat_id === "string" && input.chat_id.trim()
    ? clip(input.chat_id.trim(), 64)
    : null;
  const tradeIndex = Number.isFinite(input.trade_index) ? Math.max(0, Math.floor(input.trade_index!)) : 0;
  const key = suggestionKey(chatId, tradeIndex, trade);

  const existing = await db.prepare(
    `SELECT * FROM paper_positions WHERE user_id = ?1 AND suggestion_key = ?2`,
  ).bind(userId, key).first<PaperPositionRow>();
  if (existing) {
    const account = await ensurePaperAccount(db, userId, now);
    return {
      ok: true,
      position: rowToView(existing),
      account_cash: centsToDollars(account.cash_cents),
      created: false,
    };
  }

  const mark = await markStructure(lake, trade.ticker, trade.legs, qty, now);
  if (mark.incomplete || mark.value == null) {
    const detail = mark.legs.find((l) => l.error)?.error ?? "could not mark structure from lake quotes";
    return { ok: false, error: detail, status: 422 };
  }

  const account = await ensurePaperAccount(db, userId, now);
  const debitCents = dollarsToCents(mark.value);
  if (account.cash_cents - debitCents < 0) {
    return { ok: false, error: "insufficient paper cash", status: 400 };
  }

  const id = newId("pos");
  const legsJson = JSON.stringify(trade.legs);

  try {
    await db.batch([
      db.prepare(
        `UPDATE paper_accounts SET cash_cents = cash_cents - ?1, updated_at = ?2 WHERE user_id = ?3`,
      ).bind(debitCents, now, userId),
      db.prepare(
        `INSERT INTO paper_positions (
          id, user_id, status, source, chat_id, suggestion_key,
          ticker, bias, conviction, structure, rationale, liquidity,
          legs_json, qty, entry_value, entry_marked_at, mark_value, marked_at,
          realized_pnl, opened_at, closed_at
        ) VALUES (
          ?1, ?2, 'open', 'suggestion', ?3, ?4,
          ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, ?13, ?14, ?13, ?14,
          NULL, ?14, NULL
        )`,
      ).bind(
        id,
        userId,
        chatId,
        key,
        trade.ticker,
        trade.bias,
        trade.conviction,
        clip(trade.structure, 160),
        clip(trade.rationale, 480),
        trade.liquidity ? clip(trade.liquidity, 240) : null,
        legsJson,
        qty,
        mark.value,
        now,
      ),
    ]);
  } catch (err) {
    // Unique suggestion_key race — return the winner.
    const raced = await db.prepare(
      `SELECT * FROM paper_positions WHERE user_id = ?1 AND suggestion_key = ?2`,
    ).bind(userId, key).first<PaperPositionRow>();
    if (raced) {
      const refreshed = await ensurePaperAccount(db, userId, now);
      return {
        ok: true,
        position: rowToView(raced),
        account_cash: centsToDollars(refreshed.cash_cents),
        created: false,
      };
    }
    throw err;
  }

  const row = await db.prepare(`SELECT * FROM paper_positions WHERE id = ?1`).bind(id).first<PaperPositionRow>();
  const refreshed = await ensurePaperAccount(db, userId, now);
  if (!row) return { ok: false, error: "failed to open position", status: 500 };
  await recordDailyMarkSafe(db, {
    book: "paper",
    positionId: id,
    markValue: mark.value,
    entryValue: mark.value,
    markedAt: now,
    source: "entry",
    legsJson: JSON.stringify(mark.legs),
  });
  return {
    ok: true,
    position: rowToView(row),
    account_cash: centsToDollars(refreshed.cash_cents),
    created: true,
  };
}

export async function listPortfolio(
  db: D1Database,
  lake: LakeSql,
  userId: string,
  opts?: {
    status?: "open" | "closed" | "all";
    conviction?: TradeConviction | null;
    refreshMarks?: boolean;
  },
  now = Date.now(),
): Promise<PaperPortfolioView> {
  const account = await ensurePaperAccount(db, userId, now);
  const status = opts?.status ?? "all";
  const conviction = opts?.conviction ?? null;
  const refresh = opts?.refreshMarks !== false;

  let rows: { results?: PaperPositionRow[] };
  if (status === "all" && !conviction) {
    rows = await db.prepare(
      `SELECT * FROM paper_positions WHERE user_id = ?1 ORDER BY opened_at DESC LIMIT 200`,
    ).bind(userId).all<PaperPositionRow>();
  } else if (status === "all" && conviction) {
    rows = await db.prepare(
      `SELECT * FROM paper_positions WHERE user_id = ?1 AND conviction = ?2 ORDER BY opened_at DESC LIMIT 200`,
    ).bind(userId, conviction).all<PaperPositionRow>();
  } else if (status !== "all" && !conviction) {
    rows = await db.prepare(
      `SELECT * FROM paper_positions WHERE user_id = ?1 AND status = ?2 ORDER BY opened_at DESC LIMIT 200`,
    ).bind(userId, status).all<PaperPositionRow>();
  } else {
    rows = await db.prepare(
      `SELECT * FROM paper_positions WHERE user_id = ?1 AND status = ?2 AND conviction = ?3 ORDER BY opened_at DESC LIMIT 200`,
    ).bind(userId, status, conviction).all<PaperPositionRow>();
  }

  const positions = rows.results ?? [];
  const views: PaperPositionView[] = [];

  for (const row of positions) {
    if (refresh && row.status === "open") {
      const legs = parseLegsJson(row.legs_json);
      if (legs.length) {
        try {
          const mark = await markStructure(lake, row.ticker, legs, row.qty, now);
          if (mark.value != null) {
            await db.prepare(
              `UPDATE paper_positions SET mark_value = ?1, marked_at = ?2 WHERE id = ?3 AND user_id = ?4`,
            ).bind(mark.value, now, row.id, userId).run();
            row.mark_value = mark.value;
            row.marked_at = now;
            await recordDailyMarkSafe(db, {
              book: "paper",
              positionId: row.id,
              markValue: mark.value,
              entryValue: row.entry_value,
              markedAt: now,
              source: "refresh",
              legsJson: JSON.stringify(mark.legs),
            });
          }
        } catch {
          // Keep last persisted mark if lake is unavailable.
        }
      }
    }
    views.push(rowToView(row));
  }

  let openPnl = 0;
  let realizedPnl = 0;
  let openMarkSum = 0;
  for (const p of views) {
    if (p.status === "open") {
      if (p.unrealized_pnl != null) openPnl += p.unrealized_pnl;
      if (p.mark_value != null) openMarkSum += p.mark_value;
      else if (p.entry_value != null) openMarkSum += p.entry_value;
    } else if (p.realized_pnl != null) {
      realizedPnl += p.realized_pnl;
    }
  }

  const cash = centsToDollars(account.cash_cents);
  return {
    account: {
      cash,
      starting_cash: centsToDollars(account.starting_cash_cents),
      equity: cash + openMarkSum,
      open_pnl: openPnl,
      realized_pnl: realizedPnl,
      created_at: account.created_at,
      updated_at: account.updated_at,
    },
    positions: views,
  };
}

export type CloseResult =
  | { ok: true; position: PaperPositionView; account_cash: number }
  | { ok: false; error: string; status: number };

export async function closePosition(
  db: D1Database,
  lake: LakeSql,
  userId: string,
  positionId: string,
  now = Date.now(),
): Promise<CloseResult> {
  const row = await db.prepare(
    `SELECT * FROM paper_positions WHERE id = ?1 AND user_id = ?2`,
  ).bind(positionId, userId).first<PaperPositionRow>();
  if (!row) return { ok: false, error: "position not found", status: 404 };
  if (row.status !== "open") return { ok: false, error: "position already closed", status: 400 };

  const legs = parseLegsJson(row.legs_json);
  const mark = await markStructure(lake, row.ticker, legs, row.qty, now);
  if (mark.incomplete || mark.value == null) {
    const detail = mark.legs.find((l) => l.error)?.error ?? "could not mark structure to close";
    return { ok: false, error: detail, status: 422 };
  }

  const entry = row.entry_value ?? 0;
  const realized = mark.value - entry;
  const creditCents = dollarsToCents(mark.value);

  await db.batch([
    db.prepare(
      `UPDATE paper_accounts SET cash_cents = cash_cents + ?1, updated_at = ?2 WHERE user_id = ?3`,
    ).bind(creditCents, now, userId),
    db.prepare(
      `UPDATE paper_positions
       SET status = 'closed', mark_value = ?1, marked_at = ?2, realized_pnl = ?3, closed_at = ?2
       WHERE id = ?4 AND user_id = ?5`,
    ).bind(mark.value, now, realized, positionId, userId),
  ]);

  await recordDailyMarkSafe(db, {
    book: "paper",
    positionId,
    markValue: mark.value,
    entryValue: row.entry_value,
    markedAt: now,
    source: "close",
    legsJson: JSON.stringify(mark.legs),
  });

  const updated = await db.prepare(`SELECT * FROM paper_positions WHERE id = ?1`).bind(positionId).first<PaperPositionRow>();
  const account = await ensurePaperAccount(db, userId, now);
  if (!updated) return { ok: false, error: "failed to close position", status: 500 };
  return {
    ok: true,
    position: rowToView(updated),
    account_cash: centsToDollars(account.cash_cents),
  };
}

export function parseTrackBody(body: unknown): TrackSuggestionInput | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid JSON body" };
  }
  const rec = body as Record<string, unknown>;
  if (!rec.trade || typeof rec.trade !== "object" || Array.isArray(rec.trade)) {
    return { error: "trade is required" };
  }
  const normalized = normalizeSuggestedTrades({ trades: [rec.trade as SuggestedTrade] });
  const trade = normalized?.trades[0];
  if (!trade) return { error: "invalid trade" };
  return {
    trade,
    trade_index: typeof rec.trade_index === "number" ? rec.trade_index : undefined,
    chat_id: typeof rec.chat_id === "string" ? rec.chat_id : null,
    qty: typeof rec.qty === "number" ? rec.qty : undefined,
  };
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/**
 * Resolve the signed-in paper-book owner for a chat.
 * Prefers user_chats; falls back to a session hint (first-turn claim race).
 */
export async function resolvePaperOwnerUserId(
  db: D1Database,
  chatId: string,
  sessionUserId?: string | null,
): Promise<string | null> {
  const owner = await db.prepare(
    `SELECT user_id, deleted_at FROM user_chats WHERE chat_id = ?1`,
  ).bind(chatId).first<{ user_id: string; deleted_at: number | null }>();
  if (owner && owner.deleted_at == null) {
    if (sessionUserId && owner.user_id !== sessionUserId) return null;
    return owner.user_id;
  }
  return sessionUserId?.trim() || null;
}

/** Compact text book for Copilot tool output / prompt grounding. */
export function formatPaperPortfolioSummary(view: PaperPortfolioView): string {
  const { account, positions } = view;
  const lines = [
    "Paper portfolio",
    `Cash ${money(account.cash)} · Equity ${money(account.equity)} · Open PnL ${money(account.open_pnl)} · Realized ${money(account.realized_pnl)}`,
  ];
  if (positions.length === 0) {
    lines.push("No positions in this filter.");
    return lines.join("\n");
  }
  lines.push(`Positions (${positions.length}):`);
  for (const p of positions.slice(0, 40)) {
    const pnl = p.status === "open" ? p.unrealized_pnl : p.realized_pnl;
    const legs = p.legs.length
      ? p.legs.map(formatTradeLeg).join(", ")
      : "no legs";
    const lean = [p.bias, p.conviction].filter(Boolean).join("/") || "—";
    lines.push(
      `- ${p.ticker} · ${lean} · ${p.status} · ${p.structure} · qty ${p.qty} · entry ${money(p.entry_value)} · mark ${money(p.mark_value)} · PnL ${money(pnl)} · ${legs}`,
    );
  }
  if (positions.length > 40) lines.push(`…and ${positions.length - 40} more`);
  return lines.join("\n");
}
