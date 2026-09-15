/**
 * Run-scoped cash-debit cap for kalshi-parlay-executor.
 *
 * Spend is the sum of Kalshi portfolio combo-fill debits
 * (contracts × filled price + fee) with created_time >= this run's
 * started_at. Last night's BUY NO tape does not count: a new
 * KALSHI_PARLAY_SPEND_RUN_ID stamps started_at on first pass.
 *
 * Without a watermark (no SPEND_SINCE and no D1), live accepts are refused.
 */

import type { KalshiEnv } from "./kalshi.js";
import type { ParlayPortfolioFill } from "./kalshi-parlay-fills.js";
import { fetchKalshiPortfolioFills } from "./kalshi-parlay-tape.js";

export const PARLAY_MAX_SPEND_DEFAULT = 100;
export const PARLAY_MAX_SPEND_CAP = 10_000;
export const PARLAY_SPEND_RUN_DEFAULT = "underdog-5x100";
export const PARLAY_SPEND_META_PREFIX = "kalshi_parlay_spend_run:";

export interface ParlaySpendBudget {
  run_id: string;
  max_spend: number;
  spent: number;
  remaining: number;
  since: string | null;
  source: "env" | "d1" | "new" | "missing";
  error: string | null;
  /** False when live must not accept (no watermark, fetch failed, or cap hit). */
  can_accept: boolean;
}

function strip(raw: unknown, dflt = ""): string {
  return typeof raw === "string" ? raw.trim() : dflt;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function parlayMaxSpend(env: { KALSHI_PARLAY_MAX_SPEND?: unknown } = {}): number {
  const raw = env.KALSHI_PARLAY_MAX_SPEND;
  if (raw == null || raw === "") return PARLAY_MAX_SPEND_DEFAULT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PARLAY_MAX_SPEND_DEFAULT;
  return Math.min(PARLAY_MAX_SPEND_CAP, n);
}

export function parlaySpendRunId(env: { KALSHI_PARLAY_SPEND_RUN_ID?: unknown } = {}): string {
  return strip(env.KALSHI_PARLAY_SPEND_RUN_ID, PARLAY_SPEND_RUN_DEFAULT) || PARLAY_SPEND_RUN_DEFAULT;
}

/** Kalshi taker fee ≈ 7% of expected earnings, dollars on a $1 contract. */
export function kalshiTakerFee(price: number): number {
  const p = Number.isFinite(price) ? Math.min(1, Math.max(0, price)) : 0;
  return Math.round(0.07 * p * (1 - p) * 1e6) / 1e6;
}

export function fillCashDebit(fill: Pick<ParlayPortfolioFill, "side" | "contracts" | "yes_price" | "no_price" | "fee">): number {
  const price = fill.side === "yes" ? fill.yes_price : fill.no_price;
  return fill.contracts * price + (Number.isFinite(fill.fee) ? fill.fee : 0);
}

export function quoteYesDebit(yesAsk: number, contracts: number): number {
  if (!(contracts > 0) || !Number.isFinite(yesAsk) || yesAsk <= 0) return 0;
  return contracts * (yesAsk + kalshiTakerFee(yesAsk));
}

export function canAffordParlay(spent: number, nextDebit: number, maxSpend: number): boolean {
  return spent + nextDebit <= maxSpend + 1e-9;
}

export function sumFillSpendSince(fills: ParlayPortfolioFill[], sinceIso: string): number {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return 0;
  let sum = 0;
  for (const fill of fills) {
    const at = Date.parse(fill.created_time);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    sum += fillCashDebit(fill);
  }
  return sum;
}

export function emptyParlaySpendBudget(env: KalshiEnv = {}, live = false): ParlaySpendBudget {
  const max_spend = parlayMaxSpend(env);
  return {
    run_id: parlaySpendRunId(env),
    max_spend,
    spent: 0,
    remaining: max_spend,
    since: null,
    source: "missing",
    error: null,
    can_accept: !live,
  };
}

function loaderDb(env: KalshiEnv): NonNullable<KalshiEnv["LOADER_DB"]> | null {
  return env.LOADER_DB ?? null;
}

export async function resolveParlaySpendSince(
  env: KalshiEnv,
  nowMs = Date.now(),
): Promise<{ since: string | null; run_id: string; source: ParlaySpendBudget["source"] }> {
  const run_id = parlaySpendRunId(env);
  const override = strip(env.KALSHI_PARLAY_SPEND_SINCE);
  if (override) {
    const parsed = Date.parse(override);
    if (!Number.isFinite(parsed)) {
      throw new Error(`KALSHI_PARLAY_SPEND_SINCE is not a valid timestamp: ${override}`);
    }
    return { since: new Date(parsed).toISOString(), run_id, source: "env" };
  }
  const db = loaderDb(env);
  if (!db) return { since: null, run_id, source: "missing" };
  const key = `${PARLAY_SPEND_META_PREFIX}${run_id}`;
  const row = await db.prepare("SELECT value FROM loader_meta WHERE key = ?").bind(key).first();
  const raw = row && typeof row.value === "string" ? row.value : null;
  if (raw) {
    try {
      const rec = JSON.parse(raw) as { started_at?: unknown };
      const started = strip(rec.started_at);
      if (started && Number.isFinite(Date.parse(started))) {
        return { since: new Date(Date.parse(started)).toISOString(), run_id, source: "d1" };
      }
    } catch {
      // Fall through and restamp.
    }
  }
  const started_at = new Date(nowMs).toISOString();
  await db.prepare(
    `INSERT INTO loader_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify({ started_at, run_id }), nowMs).run();
  return { since: started_at, run_id, source: "new" };
}

export async function loadParlaySpendBudget(
  env: KalshiEnv,
  opts?: { live?: boolean; nowMs?: number; fills?: ParlayPortfolioFill[] },
): Promise<ParlaySpendBudget> {
  const max_spend = parlayMaxSpend(env);
  const resolved = await resolveParlaySpendSince(env, opts?.nowMs ?? Date.now());
  if (!resolved.since) {
    return {
      run_id: resolved.run_id,
      max_spend,
      spent: 0,
      remaining: max_spend,
      since: null,
      source: "missing",
      error: "no spend watermark (set KALSHI_PARLAY_SPEND_SINCE or persist D1 run id)",
      can_accept: false,
    };
  }
  let fills = opts?.fills;
  if (!fills) {
    fills = await fetchKalshiPortfolioFills(env);
  }
  const spent = round4(sumFillSpendSince(fills, resolved.since));
  const remaining = round4(Math.max(0, max_spend - spent));
  return {
    run_id: resolved.run_id,
    max_spend,
    spent,
    remaining,
    since: resolved.since,
    source: resolved.source,
    error: null,
    can_accept: spent < max_spend - 1e-12,
  };
}
