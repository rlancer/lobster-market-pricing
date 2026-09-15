/**
 * Sports parlay RFQ filter.
 *
 * Three executable books:
 *   - corr_room_yes: buy combo YES when makers quote near independence
 *     (Fréchet room ≥ 15¢, ask ≤ p×q + 2¢, |φ| < 0.15). Historical live rule.
 *   - same_game_underdog (code default): buy combo YES on a two-leg same-game
 *     same-side stack when the ask is ≤ 50¢. Payout is 1/ask (≥ 2x at the cap).
 *   - cross_game_longshot: buy combo YES on a two-leg cross-game same-side
 *     stack when the ask is ≤ 1/35 (~2.86¢, risk 1 to make 35) AND at or
 *     below independence. Those are the Kalshi app "2 MARKET COMBO" cards
 *     ($120 pays $4,493). accepted_side stays "yes".
 *
 * Not a CLOB screen, not mixed yes/no, not n>2, not leftover yes_last.
 */

export const PARLAY_MIN_CORR_ROOM = 0.15;
export const PARLAY_MAX_SPREAD = 0.08;
export const PARLAY_MAX_ASK_OVER_INDEP = 0.02;
export const PARLAY_MAX_ABS_PHI = 0.15;
/** Kalshi $1 face — cap 10 contracts ($10 notional / max payout). */
export const PARLAY_MAX_CONTRACTS = 10;
export const PARLAY_MAX_ACCEPTS_PER_PASS_DEFAULT = 1;
export const PARLAY_MAX_ACCEPTS_PER_PASS_CAP = 12;
/** Buy YES only when the ask is the cheap side of a $1 binary. */
export const PARLAY_UNDERDOG_MAX_COST = 0.50;
/** Risk 1 to make 35 → pay at most 1/35 per $1 face. */
export const PARLAY_MIN_PAYOUT_MULTIPLE = 35;
export const PARLAY_LONGSHOT_MAX_COST = 1 / PARLAY_MIN_PAYOUT_MULTIPLE;

export const PARLAY_BOOK_CORR_ROOM = "corr_room_yes";
export const PARLAY_BOOK_UNDERDOG = "same_game_underdog";
export const PARLAY_BOOK_LONGSHOT = "cross_game_longshot";
export const PARLAY_BOOK_DEFAULT = PARLAY_BOOK_UNDERDOG;

export type ParlayBookId =
  | typeof PARLAY_BOOK_CORR_ROOM
  | typeof PARLAY_BOOK_UNDERDOG
  | typeof PARLAY_BOOK_LONGSHOT;

export interface ParlayQuoteInput {
  market_ticker: string;
  same_game: boolean;
  /** True only for two sports legs on different games — not mixed n>2. */
  cross_game?: boolean;
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
  /** 1 / yes_ask — Kalshi "$X pays $Y" multiple. */
  payout_multiple: number;
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

export function parlayMaxAcceptsPerPass(env: {
  KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS?: unknown;
}): number {
  const raw = env.KALSHI_PARLAY_MAX_ACCEPTS_PER_PASS;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return PARLAY_MAX_ACCEPTS_PER_PASS_DEFAULT;
  return Math.min(
    PARLAY_MAX_ACCEPTS_PER_PASS_CAP,
    Math.max(1, Math.floor(n)),
  );
}

export function parlayBook(env: { KALSHI_PARLAY_BOOK?: unknown } = {}): ParlayBookId {
  const raw = String(env.KALSHI_PARLAY_BOOK ?? PARLAY_BOOK_DEFAULT).trim().toLowerCase();
  if (raw === PARLAY_BOOK_CORR_ROOM || raw === "corr_room") return PARLAY_BOOK_CORR_ROOM;
  if (
    raw === PARLAY_BOOK_LONGSHOT
    || raw === "longshot"
    || raw === "cross_game"
    || raw === "high_payout"
  ) {
    return PARLAY_BOOK_LONGSHOT;
  }
  return PARLAY_BOOK_UNDERDOG;
}

/** Kalshi combo "$X pays $Y" multiple for a $1 binary. */
export function parlayPayoutMultiple(ask: number): number {
  if (!(Number.isFinite(ask) && ask > 0)) return 0;
  return 1 / ask;
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

/** Corr-room YES — the kalshi-parlays notebook / historical live filter. */
export function evaluateParlayQuote(input: ParlayQuoteInput): ParlayQuoteDecision {
  return finishQuote(input, (stats, reasons) => {
    if (!(stats.corr_room >= PARLAY_MIN_CORR_ROOM - 1e-12)) reasons.push("corr_room");
    if (!(stats.ask_vs_indep <= PARLAY_MAX_ASK_OVER_INDEP + 1e-12)) reasons.push("ask_vs_indep");
    if (stats.phi == null || Math.abs(stats.phi) >= PARLAY_MAX_ABS_PHI) reasons.push("phi");
  });
}

/**
 * Same-game underdog YES: drop independence / φ gates; take the cheap YES
 * side (ask ≤ 50¢) on a two-leg same-game same-side two-way.
 */
export function evaluateUnderdogYesQuote(input: ParlayQuoteInput): ParlayQuoteDecision {
  return finishQuote(input, (stats, reasons) => {
    if (!(Number.isFinite(stats.yes_ask) && stats.yes_ask <= PARLAY_UNDERDOG_MAX_COST + 1e-12)) {
      reasons.push("underdog_cost");
    }
  });
}

/**
 * Cross-game longshot YES: payout ≥ 35x (ask ≤ ~2.86¢) and the quote is
 * at or cheaper than independence. Same-game correlation is the wrong model
 * here — two NFL games on one slate are close to p×q.
 */
export function evaluateLongshotYesQuote(input: ParlayQuoteInput): ParlayQuoteDecision {
  return finishQuote(input, (stats, reasons) => {
    if (!(Number.isFinite(stats.yes_ask) && stats.yes_ask <= PARLAY_LONGSHOT_MAX_COST + 1e-12)) {
      reasons.push("payout");
    }
    if (!(stats.ask_vs_indep <= 1e-12)) reasons.push("ask_vs_indep");
  }, "cross_game");
}

export function evaluateParlayExecutorQuote(
  input: ParlayQuoteInput,
  book: ParlayBookId = PARLAY_BOOK_DEFAULT,
): ParlayQuoteDecision {
  if (book === PARLAY_BOOK_CORR_ROOM) return evaluateParlayQuote(input);
  if (book === PARLAY_BOOK_LONGSHOT) return evaluateLongshotYesQuote(input);
  return evaluateUnderdogYesQuote(input);
}

function finishQuote(
  input: ParlayQuoteInput,
  extra: (
    stats: {
      yes_ask: number;
      corr_room: number;
      ask_vs_indep: number;
      phi: number | null;
    },
    reasons: string[],
  ) => void,
  game: "same_game" | "cross_game" = "same_game",
): ParlayQuoteDecision {
  const reasons: string[] = [];
  const p = clamp01(input.p);
  const q = clamp01(input.q);
  const independence = independenceJoint(p, q);
  const corr_room = corrRoom(p, q);
  const spread = input.yes_ask - input.yes_bid;
  const ask_vs_indep = input.yes_ask - independence;
  const phi = bernoulliPhi(p, q, input.yes_ask);
  const payout_multiple = parlayPayoutMultiple(input.yes_ask);

  if (input.sides.length !== 2) reasons.push("not_two_leg");
  if (game === "same_game" && !input.same_game) reasons.push("not_same_game");
  if (game === "cross_game" && !input.cross_game) reasons.push("not_cross_game");
  if (!sameSide(input.sides)) reasons.push("mixed_side");
  if (!(Number.isFinite(spread) && spread >= 0 && spread <= PARLAY_MAX_SPREAD + 1e-12)) {
    reasons.push("spread");
  }
  if (!(Number.isFinite(input.yes_ask) && input.yes_ask > 0 && input.yes_ask < 1)) {
    reasons.push("ask");
  }
  extra({ yes_ask: input.yes_ask, corr_room, ask_vs_indep, phi }, reasons);
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
    payout_multiple,
    action: ok ? "buy_yes" : "skip",
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
