/**
 * Reusable options-strategy pricing engine.
 *
 * Pure functions: given a set of legs (option or stock) and the underlying
 * spot price, compute at-expiration payoff, max profit/loss, breakeven(s),
 * and an *estimate* of the buying-power / margin requirement under simplified
 * Reg-T-style rules. No broker margin is perfectly captured here — each
 * strategy carries a `marginMethod` explainer string so the UI can show the
 * user exactly what approximation was used.
 *
 * Convention: all money values are *per share* unless suffixed `_total`.
 * One standard equity option contract = 100 shares, so `× 100 × qty` to get
 * the dollar figure for a position.
 */

export type OptType = 'call' | 'put';
export type Side = 'long' | 'short';

export interface Leg {
  /** 'call' | 'put' for options; 'stock' for a share position. */
  kind: 'option' | 'stock';
  side: Side;
  /** strike for options; entry price for stock legs (ignored if option). */
  strike?: number;
  /** per-share premium paid/received for options; per-share cost for stock. */
  price: number;
  /** number of contracts (options) or round-lots of 100 shares (stock). */
  qty: number;
  /** 'call' | 'put' — only meaningful for option legs. */
  optType?: OptType;
}

export interface PricingResult {
  name: string;
  category: StrategyCategory;
  bias: 'bullish' | 'bearish' | 'neutral' | 'volatile' | 'capital-preserving';
  legs: Leg[];
  /** per share: positive = net credit received, negative = net debit paid. */
  netCreditPerShare: number;
  /** total $ credit received (positive) or debit paid (positive). */
  netPremiumTotal: number;
  /** true if you pay money up front (debit); false if you receive credit. */
  isDebit: boolean;
  /** max profit per contract-lot, $; null = unlimited. */
  maxProfit: number | null;
  /** max loss per contract-lot, $; null = unlimited. */
  maxLoss: number | null;
  breakevens: number[];
  /** estimated buying power / margin required to put the trade on, $. */
  buyingPower: number;
  /** true when max loss is finite (defined-risk). */
  definedRisk: boolean;
  /** human-readable explanation of how buyingPower was estimated. */
  marginMethod: string;
  /** short payoff description for tooltips. */
  payoffBlurb: string;
}

export type StrategyCategory =
  | 'Single-Leg'
  | 'Vertical Spread'
  | 'Straddle/Strangle'
  | 'Iron'
  | 'Stock-Covered';

const CONTRACT = 100; // shares per option contract

/* -------------------------------------------------------------------------- *
 * Payoff at expiration (per share, pre qty)
 * -------------------------------------------------------------------------- */
export function legPayoff(leg: Leg, spot: number): number {
  if (leg.kind === 'stock') {
    const diff = spot - leg.price; // entry price
    return leg.side === 'long' ? diff : -diff;
  }
  const K = leg.strike ?? 0;
  let intrinsic: number;
  if (leg.optType === 'call') intrinsic = Math.max(spot - K, 0);
  else intrinsic = Math.max(K - spot, 0);
  // long pays premium, short receives premium
  return leg.side === 'long' ? intrinsic - leg.price : leg.price - intrinsic;
}

export function positionPayoff(legs: Leg[], spot: number, qty = 1): number {
  return legs.reduce((s, l) => s + legPayoff(l, spot) * l.qty * CONTRACT * qty, 0);
}

/* -------------------------------------------------------------------------- *
 * Buying-power / margin estimates (simplified Reg-T)
 * -------------------------------------------------------------------------- *
 * These are deliberately conservative approximations, not exchange margin.
 * The `marginMethod` string returned with every result documents the rule
 * used so the UI can surface it to the user.
 */

/** Reg-T naked short call margin, per contract, $. */
export function nakedCallMargin(spot: number, strike: number, premium: number, qty = 1): number {
  const otm = Math.max(strike - spot, 0); // call is OTM when strike > spot
  const base = Math.max(0.2 * spot - otm, 0.1 * spot);
  return (premium + base) * CONTRACT * qty;
}

/** Reg-T naked short put margin, per contract, $. */
export function nakedPutMargin(spot: number, strike: number, premium: number, qty = 1): number {
  const otm = Math.max(spot - strike, 0); // put is OTM when spot > strike
  const base = Math.max(0.2 * spot - otm, 0.1 * strike);
  return (premium + base) * CONTRACT * qty;
}

/* -------------------------------------------------------------------------- *
 * Net premium helpers
 * -------------------------------------------------------------------------- */
export function netPremiumPerShare(legs: Leg[]): number {
  // long legs pay their price (subtract), short legs receive their price (add)
  return legs.reduce((s, l) => s + (l.side === 'short' ? l.price : -l.price) * l.qty, 0);
}

/** Find breakevens by scanning a price grid for payoff sign changes. */
function findBreakevens(legs: Leg[], qty: number, lo: number, hi: number): number[] {
  const steps = 4000;
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i <= steps; i++) {
    const s = lo + (hi - lo) * (i / steps);
    const p = positionPayoff(legs, s, qty);
    if (prev !== null) {
      if ((prev < 0 && p >= 0) || (prev > 0 && p <= 0)) {
        out.push(Number(s.toFixed(2)));
      }
    }
    prev = p;
  }
  // de-duplicate (can get adjacent crossings)
  return out.filter((v, i) => i === 0 || Math.abs(v - out[i - 1]) > 0.01);
}

/* -------------------------------------------------------------------------- *
 * High-level: price a full strategy from its legs
 * -------------------------------------------------------------------------- */
export function priceStrategy(
  name: string,
  category: StrategyCategory,
  bias: PricingResult['bias'],
  legs: Leg[],
  spot: number,
  qty = 1,
  marginMethod: string,
  buyingPower: number,
  payoffBlurb: string,
): PricingResult {
  const creditPerShare = netPremiumPerShare(legs); // +credit / -debit
  const netPremiumTotal = Math.abs(creditPerShare) * CONTRACT * qty;
  const isDebit = creditPerShare < 0;

  // Scan a wide price range to classify max profit/loss and find breakevens.
  // Use a generous range: 0 to 2× spot is enough to detect "unlimited" calls.
  const hi = Math.max(spot * 2, ...legs.map((l) => l.strike ?? spot)) * 1.5 + 50;
  const lo = 0;
  const steps = 6000;
  let maxP = -Infinity;
  let minP = Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = lo + (hi - lo) * (i / steps);
    const p = positionPayoff(legs, s, qty);
    if (p > maxP) maxP = p;
    if (p < minP) minP = p;
  }

  // Unbounded classification via the asymptotic payoff slope as spot → +∞.
  // At very high prices every call is ITM (payoff slope +1 long / −1 short)
  // and every put is OTM (slope 0); stock contributes +1 long / −1 short.
  // puts and long stock are never unbounded on the left (spot floors at 0),
  // so only the right-side slope can produce ∞ profit or ∞ loss.
  //   slope_right > 0  ⇒ profit unbounded (e.g. long call, long stock)
  //   slope_right < 0  ⇒ loss   unbounded (e.g. naked call, short stock)
  // This is exact (integer slope arithmetic) and avoids the float
  // catastrophic-cancellation that comes from comparing two near-equal
  // payoff samples at large spot.
  let slopeRight = 0;
  for (const l of legs) {
    const q = l.side === 'long' ? l.qty : -l.qty;
    if (l.kind === 'stock') slopeRight += q;
    else if (l.optType === 'call') slopeRight += q; // calls ITM at +∞
    // puts contribute 0 on the right
  }
  const unboundedProfit = slopeRight > 0;
  const unboundedLoss = slopeRight < 0;

  const maxProfit = unboundedProfit ? null : Math.max(0, maxP);
  const maxLoss = unboundedLoss ? null : Math.abs(Math.min(0, minP));
  const definedRisk = maxLoss !== null;

  const breakevens = findBreakevens(legs, qty, lo, hi);

  return {
    name, category, bias, legs,
    netCreditPerShare: creditPerShare,
    netPremiumTotal,
    isDebit,
    maxProfit, maxLoss,
    breakevens,
    buyingPower: Math.round(buyingPower),
    definedRisk,
    marginMethod,
    payoffBlurb,
  };
}

/* -------------------------------------------------------------------------- *
 * Strike-picking helpers operating on a list of available strikes.
 * -------------------------------------------------------------------------- */
export interface StrikePicker {
  strikes: number[];
  spot: number;
}

function atmStrike(strikes: number[], spot: number): number {
  return strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0]);
}
/** first strike strictly above spot (for calls / OTM call wing). */
function otmCall(strikes: number[], spot: number, pct = 0): number {
  const target = spot * (1 + pct);
  const above = strikes.filter((s) => s >= target);
  if (above.length) return above.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), above[0]);
  return strikes[strikes.length - 1];
}
/** first strike strictly below spot (for puts / OTM put wing). */
function otmPut(strikes: number[], spot: number, pct = 0): number {
  const target = spot * (1 - pct);
  const below = strikes.filter((s) => s <= target && s > 0);
  if (below.length) return below.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), below[0]);
  return strikes[0];
}

/* -------------------------------------------------------------------------- *
 * Contract lookup: prefer ask when buying, bid when selling, mid otherwise.
 * `contracts` = ChainContract[] for ONE expiration, keyed by (type, strike).
 * -------------------------------------------------------------------------- */
export interface QuoteLike {
  type: 'call' | 'put';
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

function priceFor(contracts: QuoteLike[], type: OptType, strike: number, side: Side): number {
  const c = contracts.find((x) => x.type === type && x.strike === strike);
  const mid = () => {
    if (c?.bid && c?.ask && c.bid > 0 && c.ask >= c.bid) return (c.bid + c.ask) / 2;
    return c?.last ?? 0;
  };
  if (!c) return 0;
  if (side === 'long') return c.ask && c.ask > 0 ? c.ask : mid();
  return c.bid && c.bid > 0 ? c.bid : mid();
}

/* -------------------------------------------------------------------------- *
 * Strategy catalog: each builder turns (contracts, spot) into PricingResult.
 * -------------------------------------------------------------------------- */
export interface StrategyBuilder {
  name: string;
  category: StrategyCategory;
  bias: PricingResult['bias'];
  build: (contracts: QuoteLike[], spot: number, strikes: number[], qty: number) => PricingResult | null;
}

/** Common builders; each picks sensible default strikes from the chain. */
export const STRATEGY_BUILDERS: StrategyBuilder[] = [
  /* ---------------- Long Call ---------------- */
  {
    name: 'Long Call',
    category: 'Single-Leg',
    bias: 'bullish',
    build: (c, spot, strikes, qty) => {
      const K = atmStrike(strikes, spot);
      const price = priceFor(c, 'call', K, 'long');
      const legs: Leg[] = [{ kind: 'option', side: 'long', optType: 'call', strike: K, price, qty: 1 }];
      const bp = price * CONTRACT * qty; // debit paid in full
      return priceStrategy(
        'Long Call', 'Single-Leg', 'bullish', legs, spot, qty,
        'Defined risk: buying power = premium paid (debit) × 100 × qty. Long options are paid in full and have no ongoing margin requirement.',
        bp,
        'Profit grows 1:1 with the stock above the strike; lose only the premium if below.',
      );
    },
  },
  /* ---------------- Naked (Short) Call ---------------- */
  {
    name: 'Naked Call',
    category: 'Single-Leg',
    bias: 'bearish',
    build: (c, spot, strikes, qty) => {
      const K = otmCall(strikes, spot, 0.02);
      const price = priceFor(c, 'call', K, 'short');
      const legs: Leg[] = [{ kind: 'option', side: 'short', optType: 'call', strike: K, price, qty: 1 }];
      const bp = nakedCallMargin(spot, K, price, qty);
      return priceStrategy(
        'Naked Call', 'Single-Leg', 'bearish', legs, spot, qty,
        'Reg-T initial margin ≈ premium + max(20% × spot − OTM, 10% × spot), ×100 × qty. Theoretical loss is UNLIMITED if the stock rises; this estimate only covers the initial margin, not the maintenance as the stock moves.',
        bp,
        'Keep the premium if stock stays below strike; losses are theoretically unlimited above.',
      );
    },
  },
  /* ---------------- Long Put ---------------- */
  {
    name: 'Long Put',
    category: 'Single-Leg',
    bias: 'bearish',
    build: (c, spot, strikes, qty) => {
      const K = atmStrike(strikes, spot);
      const price = priceFor(c, 'put', K, 'long');
      const legs: Leg[] = [{ kind: 'option', side: 'long', optType: 'put', strike: K, price, qty: 1 }];
      const bp = price * CONTRACT * qty;
      return priceStrategy(
        'Long Put', 'Single-Leg', 'bearish', legs, spot, qty,
        'Defined risk: buying power = premium paid (debit) × 100 × qty. Max profit is bounded (stock can only fall to 0).',
        bp,
        'Profit grows as the stock falls below strike; lose only the premium if above.',
      );
    },
  },
  /* ---------------- Cash-Secured Put (full collateral) ---------------- */
  {
    name: 'Cash-Secured Put',
    category: 'Single-Leg',
    bias: 'bullish',
    build: (c, spot, strikes, qty) => {
      const K = otmPut(strikes, spot, 0.02);
      const price = priceFor(c, 'put', K, 'short');
      const legs: Leg[] = [{ kind: 'option', side: 'short', optType: 'put', strike: K, price, qty: 1 }];
      // cash-secured = full strike notional
      const bp = K * CONTRACT * qty;
      return priceStrategy(
        'Cash-Secured Put', 'Single-Leg', 'bullish', legs, spot, qty,
        'Cash-secured = full notional (strike × 100 × qty) set aside in cash. A margin account could put this on for ~Reg-T naked put margin instead (premium + max(20% × spot − OTM, 10% × strike)); shown here is the conservative full-collateral amount.',
        bp,
        'Keep the premium if stock stays above strike; if assigned you buy 100 shares at the strike.',
      );
    },
  },
  /* ---------------- Naked (Short) Put (Reg-T margin) ---------------- */
  {
    name: 'Naked Put (Reg-T)',
    category: 'Single-Leg',
    bias: 'bullish',
    build: (c, spot, strikes, qty) => {
      const K = otmPut(strikes, spot, 0.02);
      const price = priceFor(c, 'put', K, 'short');
      const legs: Leg[] = [{ kind: 'option', side: 'short', optType: 'put', strike: K, price, qty: 1 }];
      const bp = nakedPutMargin(spot, K, price, qty);
      return priceStrategy(
        'Naked Put (Reg-T)', 'Single-Leg', 'bullish', legs, spot, qty,
        'Reg-T initial margin ≈ premium + max(20% × spot − OTM, 10% × strike), ×100 × qty. Loss is large but finite (stock can only fall to 0, so max loss ≈ strike − premium). Maintenance margin rises as the stock falls.',
        bp,
        'Keep the premium if stock stays above strike; big loss if stock collapses toward zero.',
      );
    },
  },
  /* ---------------- Bull Call Spread (debit) ---------------- */
  {
    name: 'Bull Call Spread',
    category: 'Vertical Spread',
    bias: 'bullish',
    build: (c, spot, strikes, qty) => {
      const low = atmStrike(strikes, spot);
      const high = otmCall(strikes, low + (spot * 0.05), 0);
      if (high <= low) return null;
      const pLong = priceFor(c, 'call', low, 'long');
      const pShort = priceFor(c, 'call', high, 'short');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'call', strike: low, price: pLong, qty: 1 },
        { kind: 'option', side: 'short', optType: 'call', strike: high, price: pShort, qty: 1 },
      ];
      const debit = (pLong - pShort); // per share
      const bp = debit * CONTRACT * qty;
      return priceStrategy(
        'Bull Call Spread', 'Vertical Spread', 'bullish', legs, spot, qty,
        'Defined risk: buying power = net debit paid × 100 × qty. Max loss = the debit; max profit = spread width − debit.',
        bp,
        'Profits if stock rises, capped at the short strike; loss capped at the debit paid.',
      );
    },
  },
  /* ---------------- Bear Call Spread (credit) ---------------- */
  {
    name: 'Bear Call Spread',
    category: 'Vertical Spread',
    bias: 'bearish',
    build: (c, spot, strikes, qty) => {
      const low = atmStrike(strikes, spot);
      const high = otmCall(strikes, low + (spot * 0.05), 0);
      if (high <= low) return null;
      const pShort = priceFor(c, 'call', low, 'short');
      const pLong = priceFor(c, 'call', high, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'short', optType: 'call', strike: low, price: pShort, qty: 1 },
        { kind: 'option', side: 'long', optType: 'call', strike: high, price: pLong, qty: 1 },
      ];
      const credit = (pShort - pLong);
      const width = high - low;
      const bp = (width - credit) * CONTRACT * qty;
      return priceStrategy(
        'Bear Call Spread', 'Vertical Spread', 'bearish', legs, spot, qty,
        'Defined risk credit spread: buying power = (spread width − net credit) × 100 × qty. Max loss = width − credit; max profit = credit received.',
        bp,
        'Profits if stock stays below the short strike; loss capped if it rallies through both.',
      );
    },
  },
  /* ---------------- Bull Put Spread (credit) ---------------- */
  {
    name: 'Bull Put Spread',
    category: 'Vertical Spread',
    bias: 'bullish',
    build: (c, spot, strikes, qty) => {
      const high = atmStrike(strikes, spot);
      const low = otmPut(strikes, high - (spot * 0.05), 0);
      if (low >= high || low <= 0) return null;
      const pShort = priceFor(c, 'put', high, 'short');
      const pLong = priceFor(c, 'put', low, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'short', optType: 'put', strike: high, price: pShort, qty: 1 },
        { kind: 'option', side: 'long', optType: 'put', strike: low, price: pLong, qty: 1 },
      ];
      const credit = (pShort - pLong);
      const width = high - low;
      const bp = (width - credit) * CONTRACT * qty;
      return priceStrategy(
        'Bull Put Spread', 'Vertical Spread', 'bullish', legs, spot, qty,
        'Defined risk credit spread: buying power = (spread width − net credit) × 100 × qty. Max loss = width − credit; max profit = credit received.',
        bp,
        'Profits if stock stays above the short strike; loss capped if it drops through both.',
      );
    },
  },
  /* ---------------- Bear Put Spread (debit) ---------------- */
  {
    name: 'Bear Put Spread',
    category: 'Vertical Spread',
    bias: 'bearish',
    build: (c, spot, strikes, qty) => {
      const high = atmStrike(strikes, spot);
      const low = otmPut(strikes, high - (spot * 0.05), 0);
      if (low >= high || low <= 0) return null;
      const pLong = priceFor(c, 'put', high, 'long');
      const pShort = priceFor(c, 'put', low, 'short');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'put', strike: high, price: pLong, qty: 1 },
        { kind: 'option', side: 'short', optType: 'put', strike: low, price: pShort, qty: 1 },
      ];
      const debit = (pLong - pShort);
      const bp = debit * CONTRACT * qty;
      return priceStrategy(
        'Bear Put Spread', 'Vertical Spread', 'bearish', legs, spot, qty,
        'Defined risk: buying power = net debit paid × 100 × qty. Max loss = the debit; max profit = spread width − debit.',
        bp,
        'Profits if stock falls, capped at the short strike; loss capped at the debit paid.',
      );
    },
  },
  /* ---------------- Long Straddle ---------------- */
  {
    name: 'Long Straddle',
    category: 'Straddle/Strangle',
    bias: 'volatile',
    build: (c, spot, strikes, qty) => {
      const K = atmStrike(strikes, spot);
      const cp = priceFor(c, 'call', K, 'long');
      const pp = priceFor(c, 'put', K, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'call', strike: K, price: cp, qty: 1 },
        { kind: 'option', side: 'long', optType: 'put', strike: K, price: pp, qty: 1 },
      ];
      const bp = (cp + pp) * CONTRACT * qty;
      return priceStrategy(
        'Long Straddle', 'Straddle/Strangle', 'volatile', legs, spot, qty,
        'Defined risk: buying power = total debit (both premiums) × 100 × qty. Profit is large if the stock moves sharply either way; lose the debit if it pins at the strike.',
        bp,
        'Two breakevens (strike ± total debit); profit beyond either, unlimited on the upside.',
      );
    },
  },
  /* ---------------- Short Straddle ---------------- */
  {
    name: 'Short Straddle',
    category: 'Straddle/Strangle',
    bias: 'neutral',
    build: (c, spot, strikes, qty) => {
      const K = atmStrike(strikes, spot);
      const cp = priceFor(c, 'call', K, 'short');
      const pp = priceFor(c, 'put', K, 'short');
      const legs: Leg[] = [
        { kind: 'option', side: 'short', optType: 'call', strike: K, price: cp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'put', strike: K, price: pp, qty: 1 },
      ];
      // only one side can be ITM at expiry, so margin ≈ max(call req, put req)
      const callReq = nakedCallMargin(spot, K, cp, qty);
      const putReq = nakedPutMargin(spot, K, pp, qty);
      const bp = Math.max(callReq, putReq);
      return priceStrategy(
        'Short Straddle', 'Straddle/Strangle', 'neutral', legs, spot, qty,
        'Undefined risk. Reg-T combination margin ≈ the GREATER of the naked-call or naked-put requirement (since only one side can be ITM at expiry). Theoretical loss is unlimited on a rally; large loss on a crash down to ~strike. Brokers often require more; this is a lower bound.',
        bp,
        'Two breakevens (strike ± total credit); keep premium if stock pins at the strike.',
      );
    },
  },
  /* ---------------- Long Strangle ---------------- */
  {
    name: 'Long Strangle',
    category: 'Straddle/Strangle',
    bias: 'volatile',
    build: (c, spot, strikes, qty) => {
      const kc = otmCall(strikes, spot, 0.03);
      const kp = otmPut(strikes, spot, 0.03);
      if (kc <= kp) return null;
      const cp = priceFor(c, 'call', kc, 'long');
      const pp = priceFor(c, 'put', kp, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'call', strike: kc, price: cp, qty: 1 },
        { kind: 'option', side: 'long', optType: 'put', strike: kp, price: pp, qty: 1 },
      ];
      const bp = (cp + pp) * CONTRACT * qty;
      return priceStrategy(
        'Long Strangle', 'Straddle/Strangle', 'volatile', legs, spot, qty,
        'Defined risk: buying power = total debit (both premiums) × 100 × qty. Cheaper than a straddle but needs a bigger move to profit.',
        bp,
        'Breakevens at call strike + debit and put strike − debit; needs a large move either way.',
      );
    },
  },
  /* ---------------- Short Strangle ---------------- */
  {
    name: 'Short Strangle',
    category: 'Straddle/Strangle',
    bias: 'neutral',
    build: (c, spot, strikes, qty) => {
      const kc = otmCall(strikes, spot, 0.05);
      const kp = otmPut(strikes, spot, 0.05);
      if (kc <= kp) return null;
      const cp = priceFor(c, 'call', kc, 'short');
      const pp = priceFor(c, 'put', kp, 'short');
      const legs: Leg[] = [
        { kind: 'option', side: 'short', optType: 'call', strike: kc, price: cp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'put', strike: kp, price: pp, qty: 1 },
      ];
      const callReq = nakedCallMargin(spot, kc, cp, qty);
      const putReq = nakedPutMargin(spot, kp, pp, qty);
      const bp = Math.max(callReq, putReq);
      return priceStrategy(
        'Short Strangle', 'Straddle/Strangle', 'neutral', legs, spot, qty,
        'Undefined risk. Reg-T combination margin ≈ the GREATER of the naked-call or naked-put requirement. Both wings can expire worthless (best case), but a rally past the call strike is unlimited loss. Broker minimums often higher.',
        bp,
        'Keep the full credit if the stock stays between the two strikes.',
      );
    },
  },
  /* ---------------- Iron Condor ---------------- */
  {
    name: 'Iron Condor',
    category: 'Iron',
    bias: 'neutral',
    build: (c, spot, strikes, qty) => {
      const shortPut = otmPut(strikes, spot, 0.05);
      const longPut = otmPut(strikes, shortPut - (spot * 0.05), 0);
      const shortCall = otmCall(strikes, spot, 0.05);
      const longCall = otmCall(strikes, shortCall + (spot * 0.05), 0);
      if (longPut <= 0 || longCall <= shortCall || shortPut <= longPut) return null;
      const sp = priceFor(c, 'put', shortPut, 'short');
      const lp = priceFor(c, 'put', longPut, 'long');
      const sc = priceFor(c, 'call', shortCall, 'short');
      const lc = priceFor(c, 'call', longCall, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'put', strike: longPut, price: lp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'put', strike: shortPut, price: sp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'call', strike: shortCall, price: sc, qty: 1 },
        { kind: 'option', side: 'long', optType: 'call', strike: longCall, price: lc, qty: 1 },
      ];
      const credit = (sp + sc) - (lp + lc);
      const width = Math.max(shortPut - longPut, longCall - shortCall);
      const bp = (width - credit) * CONTRACT * qty;
      return priceStrategy(
        'Iron Condor', 'Iron', 'neutral', legs, spot, qty,
        'Defined risk: buying power = (widest wing width − net credit) × 100 × qty. Both spreads are defined-risk so total loss is capped at wing width − credit.',
        bp,
        'Keep the credit if stock stays between the two short strikes; capped loss if it exits either wing.',
      );
    },
  },
  /* ---------------- Iron Butterfly ---------------- */
  {
    name: 'Iron Butterfly',
    category: 'Iron',
    bias: 'neutral',
    build: (c, spot, strikes, qty) => {
      const K = atmStrike(strikes, spot);
      const longPut = otmPut(strikes, K - (spot * 0.05), 0);
      const longCall = otmCall(strikes, K + (spot * 0.05), 0);
      if (longPut <= 0 || longCall <= K) return null;
      const sp = priceFor(c, 'put', K, 'short');
      const sc = priceFor(c, 'call', K, 'short');
      const lp = priceFor(c, 'put', longPut, 'long');
      const lc = priceFor(c, 'call', longCall, 'long');
      const legs: Leg[] = [
        { kind: 'option', side: 'long', optType: 'put', strike: longPut, price: lp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'put', strike: K, price: sp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'call', strike: K, price: sc, qty: 1 },
        { kind: 'option', side: 'long', optType: 'call', strike: longCall, price: lc, qty: 1 },
      ];
      const credit = (sp + sc) - (lp + lc);
      const width = Math.max(K - longPut, longCall - K);
      const bp = (width - credit) * CONTRACT * qty;
      return priceStrategy(
        'Iron Butterfly', 'Iron', 'neutral', legs, spot, qty,
        'Defined risk: buying power = (wing width − net credit) × 100 × qty. Highest credit when stock pins at the center strike; capped loss on a large move either way.',
        bp,
        'Max profit at the center strike; loss grows toward either wing and caps beyond it.',
      );
    },
  },
  /* ---------------- Covered Call ---------------- */
  {
    name: 'Covered Call',
    category: 'Stock-Covered',
    bias: 'neutral',
    build: (c, spot, strikes, qty) => {
      const K = otmCall(strikes, spot, 0.02);
      const cp = priceFor(c, 'call', K, 'short');
      const legs: Leg[] = [
        { kind: 'stock', side: 'long', price: spot, qty: 1 }, // 100 shares per call
        { kind: 'option', side: 'short', optType: 'call', strike: K, price: cp, qty: 1 },
      ];
      // capital = share notional; the short call adds no margin because covered
      const bp = spot * CONTRACT * qty;
      return priceStrategy(
        'Covered Call', 'Stock-Covered', 'neutral', legs, spot, qty,
        'Capital = share notional (spot × 100 × qty) to hold 100 shares per call. The short call is fully covered by the shares, so no extra option margin. On a Reg-T margin account the shares could be held at ~50% notional instead of 100%.',
        bp,
        'Upside capped at the strike + premium; keep the stock and the credit if below strike.',
      );
    },
  },
  /* ---------------- Collar ---------------- */
  {
    name: 'Collar',
    category: 'Stock-Covered',
    bias: 'capital-preserving',
    build: (c, spot, strikes, qty) => {
      const longPutK = otmPut(strikes, spot, 0.05);
      const shortCallK = otmCall(strikes, spot, 0.05);
      if (shortCallK <= longPutK) return null;
      const pp = priceFor(c, 'put', longPutK, 'long');
      const cp = priceFor(c, 'call', shortCallK, 'short');
      const legs: Leg[] = [
        { kind: 'stock', side: 'long', price: spot, qty: 1 },
        { kind: 'option', side: 'long', optType: 'put', strike: longPutK, price: pp, qty: 1 },
        { kind: 'option', side: 'short', optType: 'call', strike: shortCallK, price: cp, qty: 1 },
      ];
      const bp = spot * CONTRACT * qty; // share notional; options roughly net out
      return priceStrategy(
        'Collar', 'Stock-Covered', 'capital-preserving', legs, spot, qty,
        'Capital ≈ share notional (spot × 100 × qty); the put is paid for and the call is covered by the shares. Net option cost is usually small. Floor and ceiling are both defined.',
        bp,
        'Downside floored at the put strike − net debit; upside capped at the call strike + net credit.',
      );
    },
  },
];
