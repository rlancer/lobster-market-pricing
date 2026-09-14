/**
 * Same-game sports parlay RFQ filter.
 *
 * Buy the combo YES only when makers quote near independence on a two-leg
 * same-game same-side stack with enough Fréchet room to clear spread + fees.
 * This is the executable rule from the kalshi-parlays notebook — not a CLOB
 * screen, not mixed yes/no, not n>2, not leftover yes_last.
 */

export const PARLAY_MIN_CORR_ROOM = 0.15;
export const PARLAY_MAX_SPREAD = 0.08;
export const PARLAY_MAX_ASK_OVER_INDEP = 0.02;
export const PARLAY_MAX_ABS_PHI = 0.15;
export const PARLAY_MAX_CONTRACTS = 10;

export interface ParlayQuoteInput {
  market_ticker: string;
  same_game: boolean;
  sides: Array<"yes" | "no">;
  /** Selected-side probabilities of the two legs (NO uses 1 − yes mid). */
  p: number;
  q: number;
  yes_bid: number;
  yes_ask: number;
  /** Single-maker quote id. Synthetic/mixed TOB two-ways cannot be accepted. */
  quote_id?: string | null;
}

export interface ParlayQuoteDecision {
  ok: boolean;
  reasons: string[];
  independence: number;
  corr_room: number;
  spread: number;
  ask_vs_indep: number;
  phi: number | null;
  action: "buy_yes" | "skip";
}

export function truthyFlag(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function parlayExecuteEnabled(env: { KALSHI_PARLAY_EXECUTE?: unknown }): boolean {
  return truthyFlag(env.KALSHI_PARLAY_EXECUTE);
}

export function parlayLiveEnabled(env: {
  KALSHI_PARLAY_EXECUTE?: unknown;
  KALSHI_PARLAY_LIVE?: unknown;
}): boolean {
  return parlayExecuteEnabled(env) && truthyFlag(env.KALSHI_PARLAY_LIVE);
}

export function independenceJoint(p: number, q: number): number {
  return clamp01(p) * clamp01(q);
}

export function corrRoom(p: number, q: number): number {
  const pp = clamp01(p);
  const qq = clamp01(q);
  return Math.max(0, Math.min(pp, qq) - pp * qq);
}

/** Bernoulli phi using the ask as the joint we would pay. */
export function bernoulliPhi(p: number, q: number, joint: number): number | null {
  const pp = clamp01(p);
  const qq = clamp01(q);
  const den = Math.sqrt(pp * (1 - pp) * qq * (1 - qq));
  if (!(den > 0)) return null;
  return (joint - pp * qq) / den;
}

export function sameSide(sides: Array<"yes" | "no">): boolean {
  if (sides.length < 2) return false;
  return sides.every((side) => side === sides[0]);
}

export function evaluateParlayQuote(input: ParlayQuoteInput): ParlayQuoteDecision {
  const reasons: string[] = [];
  const p = clamp01(input.p);
  const q = clamp01(input.q);
  const independence = independenceJoint(p, q);
  const corr_room = corrRoom(p, q);
  const spread = input.yes_ask - input.yes_bid;
  const ask_vs_indep = input.yes_ask - independence;
  const phi = bernoulliPhi(p, q, input.yes_ask);

  if (input.sides.length !== 2) reasons.push("not_two_leg");
  if (!input.same_game) reasons.push("not_same_game");
  if (!sameSide(input.sides)) reasons.push("mixed_side");
  if (!(corr_room >= PARLAY_MIN_CORR_ROOM - 1e-12)) reasons.push("corr_room");
  if (!(Number.isFinite(spread) && spread >= 0 && spread <= PARLAY_MAX_SPREAD + 1e-12)) {
    reasons.push("spread");
  }
  if (!(Number.isFinite(input.yes_ask) && input.yes_ask > 0 && input.yes_ask < 1)) {
    reasons.push("ask");
  }
  if (!(ask_vs_indep <= PARLAY_MAX_ASK_OVER_INDEP + 1e-12)) reasons.push("ask_vs_indep");
  if (phi == null || Math.abs(phi) >= PARLAY_MAX_ABS_PHI) reasons.push("phi");
  if (!input.quote_id) reasons.push("no_quote_id");

  const ok = reasons.length === 0;
  return {
    ok,
    reasons,
    independence,
    corr_room,
    spread,
    ask_vs_indep,
    phi,
    action: ok ? "buy_yes" : "skip",
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
