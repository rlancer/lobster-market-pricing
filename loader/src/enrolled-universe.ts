import universe from "../symbols/universe.json";
import { securityIdForTicker } from "./symbology.js";
import type { D1Database } from "./scheduler.js";

const BUNDLED: string[] = Array.isArray(universe.symbols)
  ? (universe.symbols as string[]).map((s) => String(s).toUpperCase())
  : [];

const BUNDLED_SET = new Set(BUNDLED);

export interface EnrollOpts {
  source?: string;
  requestedBy?: string | null;
  notes?: string | null;
  /** Epoch ms; defaults to Date.now(). */
  now?: number;
  /** Base backoff seconds written into item stores. */
  backoffBaseSeconds?: number;
}

export interface EnrollResult {
  symbol: string;
  enrolled: boolean;
  already: boolean;
  bundled: boolean;
  enabled: boolean;
}

export interface EnrolledRow {
  symbol: string;
  source: string;
  requested_by: string | null;
  requested_at: number;
  enabled: number;
  last_error: string | null;
  notes: string | null;
  [key: string]: unknown;
}

/** Bundled manifest symbols (S&P 500 + NDX delta + ETFs). */
export function bundledUniverse(): string[] {
  return BUNDLED.slice();
}

export function isBundledSymbol(symbol: string): boolean {
  return BUNDLED_SET.has(String(symbol || "").toUpperCase());
}

/**
 * Equity/ETF OCC roots only — indexes (^VIX), continuous futures (ES=F), and
 * spot crypto (BTC-USD) use dedicated manifests and must not enter the equity
 * ETL path.
 */
export function isEnrollableTicker(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = String(raw).trim().toUpperCase();
  if (!t || t.startsWith("^") || t.includes("=") || t.startsWith("/")) return false;
  if (t.endsWith("-USD")) return false;
  return /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t);
}

export function normalizeEnrollTicker(raw: string | null | undefined): string | null {
  if (!isEnrollableTicker(raw)) return null;
  return String(raw).trim().toUpperCase();
}

/** Enabled on-demand symbols from D1 (empty when the table is missing). */
export async function listEnrolledSymbols(db: D1Database): Promise<string[]> {
  try {
    const rows = await db
      .prepare(
        `SELECT symbol FROM enrolled_symbols
         WHERE enabled = 1
         ORDER BY symbol ASC`,
      )
      .all<{ symbol: string }>();
    return (rows.results || [])
      .map((r) => String(r.symbol || "").toUpperCase())
      .filter(Boolean);
  } catch {
    // Migration not applied yet — behave as empty enrollment.
    return [];
  }
}

export async function countEnrolledSymbols(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM enrolled_symbols WHERE enabled = 1`)
      .first();
    return row && typeof row.c === "number" ? row.c : Number(row?.c) || 0;
  } catch {
    return 0;
  }
}

/** Bundled ∪ enrolled, de-duplicated, uppercased, sorted. */
export async function effectiveUniverse(db?: D1Database): Promise<string[]> {
  const enrolled = db ? await listEnrolledSymbols(db) : [];
  const set = new Set(BUNDLED);
  for (const s of enrolled) set.add(s);
  return Array.from(set).sort();
}

export async function expectedUniverseSize(db?: D1Database): Promise<number> {
  // Enrolled symbols already in the bundled list must not inflate seedSize.
  const enrolled = db ? await listEnrolledSymbols(db) : [];
  let extra = 0;
  for (const s of enrolled) {
    if (!BUNDLED_SET.has(s)) extra += 1;
  }
  return BUNDLED.length + extra;
}

/**
 * Persist enrollment and seed every equity item store so the continuous
 * scheduler picks the ticker up without waiting for a universe re-seed.
 * Idempotent: re-enrolling an enabled symbol is a no-op success.
 */
export async function enrollSymbol(
  db: D1Database,
  rawSymbol: string,
  opts: EnrollOpts = {},
): Promise<EnrollResult> {
  const symbol = normalizeEnrollTicker(rawSymbol);
  if (!symbol) {
    throw new Error(`invalid enrollable ticker: ${rawSymbol}`);
  }

  const now = opts.now ?? Date.now();
  const base = Math.max(1, Math.floor(opts.backoffBaseSeconds ?? 60));
  const source = (opts.source || "on_demand").slice(0, 64);
  const requestedBy = opts.requestedBy ? String(opts.requestedBy).slice(0, 128) : null;
  const notes = opts.notes ? String(opts.notes).slice(0, 512) : null;
  const bundled = BUNDLED_SET.has(symbol);

  let already = false;
  try {
    const existing = await db
      .prepare(`SELECT symbol, enabled FROM enrolled_symbols WHERE symbol = ?`)
      .bind(symbol)
      .first();
    if (existing) {
      already = true;
      if (Number(existing.enabled) !== 1) {
        await db
          .prepare(
            `UPDATE enrolled_symbols
               SET enabled = 1, source = ?, requested_by = COALESCE(?, requested_by),
                   notes = COALESCE(?, notes), last_error = NULL
             WHERE symbol = ?`,
          )
          .bind(source, requestedBy, notes, symbol)
          .run();
      }
    } else {
      await db
        .prepare(
          `INSERT INTO enrolled_symbols
             (symbol, source, requested_by, requested_at, enabled, last_error, notes)
           VALUES (?, ?, ?, ?, 1, NULL, ?)`,
        )
        .bind(symbol, source, requestedBy, now, notes)
        .run();
    }
  } catch (error) {
    throw new Error(
      `enrolled_symbols write failed (is migration 0005 applied?): ${
        (error && (error as Error).message) || error
      }`,
    );
  }

  // Due immediately so the next cboe-options / backfill / research pass picks it up.
  await db
    .prepare(
      `INSERT OR IGNORE INTO symbol_state
         (symbol, enabled, last_success_at, last_attempt_at, consecutive_failures,
          next_attempt_after, backoff_seconds, last_error, priority)
       VALUES (?, 1, NULL, NULL, 0, 0, ?, NULL, 0)`,
    )
    .bind(symbol, base)
    .run();
  await db
    .prepare(
      `UPDATE symbol_state
         SET enabled = 1, next_attempt_after = 0, last_error = NULL
       WHERE symbol = ?`,
    )
    .bind(symbol)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO ohlc_backfill_state
         (symbol, security_id, enabled, last_success_at, last_attempt_at,
          consecutive_failures, next_attempt_after, backoff_seconds,
          last_error, priority)
       VALUES (?, ?, 1, NULL, NULL, 0, 0, ?, NULL, 0)`,
    )
    .bind(symbol, securityIdForTicker(symbol), base)
    .run();
  await db
    .prepare(
      `UPDATE ohlc_backfill_state
         SET enabled = 1, next_attempt_after = 0, last_error = NULL
       WHERE symbol = ?`,
    )
    .bind(symbol)
    .run();

  await db
    .prepare(
      `INSERT OR IGNORE INTO research_brief_state
         (symbol, enabled, last_success_at, last_attempt_at,
          consecutive_failures, next_attempt_after, backoff_seconds,
          last_error, priority)
       VALUES (?, 1, NULL, NULL, 0, 0, ?, NULL, 0)`,
    )
    .bind(symbol, base)
    .run();
  await db
    .prepare(
      `UPDATE research_brief_state
         SET enabled = 1, next_attempt_after = 0, last_error = NULL
       WHERE symbol = ?`,
    )
    .bind(symbol)
    .run();

  return {
    symbol,
    enrolled: true,
    already,
    bundled,
    enabled: true,
  };
}

export async function listEnrolledRows(
  db: D1Database,
  opts: { limit?: number; offset?: number } = {},
): Promise<EnrolledRow[]> {
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  try {
    const rows = await db
      .prepare(
        `SELECT symbol, source, requested_by, requested_at, enabled, last_error, notes
         FROM enrolled_symbols
         ORDER BY requested_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset)
      .all<EnrolledRow>();
    return rows.results || [];
  } catch {
    return [];
  }
}
