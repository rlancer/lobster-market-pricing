/**
 * Structured suggested trades for Copilot.
 *
 * Emitted via the suggest_trades tool so the UI can render concrete legs
 * without parsing freeform markdown. Legs must come from lake evidence
 * (option_contracts quotes) when the model names absolute strikes.
 */

export type TradeBias = "bullish" | "bearish" | "neutral";
export type TradeConviction = "high" | "medium" | "low";
export type OptionRight = "call" | "put";
export type TradeSide = "buy" | "sell";

export interface TradeLeg {
  right: OptionRight;
  side: TradeSide;
  /** Absolute strike when grounded in option_contracts. */
  strike?: number;
  /** Relative strike when absolute is unknown (e.g. "ATM", "~5% OTM"). */
  strike_rel?: string;
  /** YYYY-MM-DD expiration when known. */
  expiration?: string;
  dte?: number;
}

export interface SuggestedTrade {
  ticker: string;
  bias: TradeBias;
  conviction: TradeConviction;
  /** Short structure label (bull call debit spread, iron condor, …). */
  structure: string;
  legs?: TradeLeg[];
  rationale: string;
  /** Quote quality from lake (spread, volume/OI) — omit if unknown. */
  liquidity?: string;
}

export interface SuggestedTrades {
  trades: SuggestedTrade[];
  /** When trades is empty: why no tradable lean (thin book, no signal, …). */
  skip_reason?: string;
}

const STRUCTURE_MAX = 160;
const RATIONALE_MAX = 480;
const LIQUIDITY_MAX = 240;
const SKIP_REASON_MAX = 320;
const STRIKE_REL_MAX = 40;
const TICKER_MAX = 16;
const TRADES_MAX = 3;
const LEGS_MAX = 4;

const BIASES = new Set<TradeBias>(["bullish", "bearish", "neutral"]);
const CONVICTIONS = new Set<TradeConviction>(["high", "medium", "low"]);
const RIGHTS = new Set<OptionRight>(["call", "put"]);
const SIDES = new Set<TradeSide>(["buy", "sell"]);

function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function asBias(value: unknown): TradeBias | null {
  return typeof value === "string" && BIASES.has(value as TradeBias) ? value as TradeBias : null;
}

function asConviction(value: unknown): TradeConviction | null {
  return typeof value === "string" && CONVICTIONS.has(value as TradeConviction)
    ? value as TradeConviction
    : null;
}

function normalizeLeg(raw: unknown): TradeLeg | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const right = typeof rec.right === "string" && RIGHTS.has(rec.right as OptionRight)
    ? rec.right as OptionRight
    : null;
  const side = typeof rec.side === "string" && SIDES.has(rec.side as TradeSide)
    ? rec.side as TradeSide
    : null;
  if (!right || !side) return null;

  const strike = typeof rec.strike === "number" && Number.isFinite(rec.strike) && rec.strike > 0
    ? rec.strike
    : undefined;
  const strike_rel = typeof rec.strike_rel === "string" && rec.strike_rel.trim()
    ? clip(rec.strike_rel, STRIKE_REL_MAX)
    : undefined;
  if (strike == null && !strike_rel) return null;

  const expiration = typeof rec.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rec.expiration.trim())
    ? rec.expiration.trim()
    : undefined;
  const dte = typeof rec.dte === "number" && Number.isFinite(rec.dte) && rec.dte >= 0 && rec.dte <= 730
    ? Math.floor(rec.dte)
    : undefined;

  return {
    right,
    side,
    ...(strike != null ? { strike } : {}),
    ...(strike_rel ? { strike_rel } : {}),
    ...(expiration ? { expiration } : {}),
    ...(dte != null ? { dte } : {}),
  };
}

function normalizeTrade(raw: unknown): SuggestedTrade | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const ticker = typeof rec.ticker === "string" ? clip(rec.ticker.toUpperCase(), TICKER_MAX) : "";
  const bias = asBias(rec.bias);
  const conviction = asConviction(rec.conviction);
  const structure = typeof rec.structure === "string" ? clip(rec.structure, STRUCTURE_MAX) : "";
  const rationale = typeof rec.rationale === "string" ? clip(rec.rationale, RATIONALE_MAX) : "";
  if (!ticker || !bias || !conviction || !structure || !rationale) return null;

  const legsRaw = Array.isArray(rec.legs) ? rec.legs.slice(0, LEGS_MAX) : [];
  const legs = legsRaw.map(normalizeLeg).filter((leg): leg is TradeLeg => leg != null);

  const liquidity = typeof rec.liquidity === "string" && rec.liquidity.trim()
    ? clip(rec.liquidity, LIQUIDITY_MAX)
    : undefined;

  return {
    ticker,
    bias,
    conviction,
    structure,
    ...(legs.length ? { legs } : {}),
    rationale,
    ...(liquidity ? { liquidity } : {}),
  };
}

/** Normalize / bound a suggest_trades payload for tool output + UI. */
export function normalizeSuggestedTrades(input: {
  trades?: unknown;
  skip_reason?: unknown;
} | null | undefined): SuggestedTrades | null {
  if (!input || typeof input !== "object") return null;
  // Require an explicit trades array — missing key is incomplete, not "no lean".
  if (!Array.isArray(input.trades)) return null;
  const tradesRaw = input.trades.slice(0, TRADES_MAX);
  const trades = tradesRaw.map(normalizeTrade).filter((t): t is SuggestedTrade => t != null);
  const skip_reason = typeof input.skip_reason === "string" && input.skip_reason.trim()
    ? clip(input.skip_reason, SKIP_REASON_MAX)
    : undefined;

  if (trades.length === 0) {
    // Empty list is a valid "no lean" — do not reject missing skip_reason.
    // Models often omit it under forced toolChoice; rejecting it spun the loop
    // until the turn budget burned (share 1KJpGTK37GDr9SlDCaJxd3aa).
    return {
      trades: [],
      skip_reason: skip_reason ?? "No tradable lean from the shared evidence",
    };
  }
  return { trades, ...(skip_reason ? { skip_reason } : {}) };
}

export function formatTradesToolSummary(payload: SuggestedTrades): string {
  if (payload.trades.length === 0) {
    return `No suggested trades — ${payload.skip_reason ?? "no reason given"}`;
  }
  const lines = payload.trades.map((trade) => {
    const bias = trade.bias[0]!.toUpperCase() + trade.bias.slice(1);
    return `${trade.ticker} · ${bias} (${trade.conviction}) · ${trade.structure}`;
  });
  return [`Suggested trades (${payload.trades.length}):`, ...lines].join("\n");
}

/** Prompt block: emit trades only via suggest_trades (no freeform parsing). */
export function tradesSuggestBlock(): string {
  return [
    "Suggested trades (structured — never freeform-only):",
    "- After publish_desk on ticker / trade analysis, MUST call suggest_trades before final prose. The UI renders trades from this tool only — do not bury legs in markdown.",
    "- Each trade needs ticker, bias (bullish|bearish|neutral), conviction (high|medium|low), structure label, and rationale grounded in shared evidence.",
    "- Prefer 1–2 defined-risk ideas. Include legs (buy/sell + call/put + strike or strike_rel + expiration/dte) when option_contracts quotes support them.",
    "- Absolute strikes/expiries MUST come from a prior option_contracts query with two-sided quotes (bid>0, ask>=bid), tight-ish spread, and volume/OI interest. Put that quote quality in liquidity.",
    "- If nothing is tradable, pass trades: [] (skip_reason optional). Never invent fills or far-OTM lottery tickets.",
    "- After suggest_trades, final message text stays the desk overview only (1–4 sentences). Do not re-list the trades in prose.",
  ].join("\n");
}
