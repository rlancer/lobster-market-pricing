/**
 * Structured suggested trades for Copilot.
 *
 * Emitted via the suggest_trades tool so the UI can render concrete legs
 * without parsing freeform markdown. Legs are a formal discriminant:
 * option contracts (call/put + strike), equity (stock/ETF long/short), or
 * Kalshi event contracts (market_ticker + yes/no side). Absolute option
 * strikes must come from lake evidence (option_contracts); Kalshi legs from
 * options.kalshi_markets.
 */

export type TradeBias = "bullish" | "bearish" | "neutral";
export type TradeConviction = "high" | "medium" | "low";
export type OptionRight = "call" | "put";
export type TradeSide = "buy" | "sell";
export type KalshiContractSide = "yes" | "no";
/** Option contract vs underlying shares vs Kalshi event contract. */
export type LegInstrument = "option" | "equity" | "kalshi";

interface TradeLegBase {
  side: TradeSide;
  /**
   * Size: option contracts, equity shares, or Kalshi contracts.
   * Optional at suggestion time; preferred when the idea is sized.
   */
  qty?: number;
  /**
   * Override when the leg is not the parent trade ticker (rare; e.g. pairs).
   * Defaults to SuggestedTrade.ticker when omitted.
   */
  symbol?: string;
}

/** Listed call/put — needs right + (strike or strike_rel). */
export interface OptionTradeLeg extends TradeLegBase {
  instrument: "option";
  right: OptionRight;
  /** Absolute strike when grounded in option_contracts. */
  strike?: number;
  /** Relative strike when absolute is unknown (e.g. "ATM", "~5% OTM"). */
  strike_rel?: string;
  /** YYYY-MM-DD expiration when known. */
  expiration?: string;
  dte?: number;
}

/** Long (buy) or short (sell) stock / ETF shares. */
export interface EquityTradeLeg extends TradeLegBase {
  instrument: "equity";
}

/** Kalshi binary event contract — buy/sell YES or NO. */
export interface KalshiTradeLeg extends TradeLegBase {
  instrument: "kalshi";
  /** Full Kalshi market ticker from options.kalshi_markets (e.g. KXFED-27APR-T4.25). */
  market_ticker: string;
  /** Which side of the binary; defaults to yes. */
  contract_side?: KalshiContractSide;
}

export type TradeLeg = OptionTradeLeg | EquityTradeLeg | KalshiTradeLeg;

export interface SuggestedTrade {
  ticker: string;
  bias: TradeBias;
  conviction: TradeConviction;
  /** Short structure label (bull call debit spread, long shares, buy Kalshi YES, …). */
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
const MARKET_TICKER_MAX = 64;
const TRADES_MAX = 3;
const LEGS_MAX = 4;
const QTY_MAX = 1_000_000;

const BIASES = new Set<TradeBias>(["bullish", "bearish", "neutral"]);
const CONVICTIONS = new Set<TradeConviction>(["high", "medium", "low"]);
const RIGHTS = new Set<OptionRight>(["call", "put"]);
const SIDES = new Set<TradeSide>(["buy", "sell"]);
const INSTRUMENTS = new Set<LegInstrument>(["option", "equity", "kalshi"]);
const CONTRACT_SIDES = new Set<KalshiContractSide>(["yes", "no"]);

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

function asSide(value: unknown): TradeSide | null {
  return typeof value === "string" && SIDES.has(value as TradeSide) ? value as TradeSide : null;
}

function asRight(value: unknown): OptionRight | null {
  return typeof value === "string" && RIGHTS.has(value as OptionRight) ? value as OptionRight : null;
}

function asContractSide(value: unknown): KalshiContractSide | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return CONTRACT_SIDES.has(lower as KalshiContractSide)
    ? lower as KalshiContractSide
    : undefined;
}

function asQty(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > QTY_MAX) {
    return undefined;
  }
  return Math.floor(value);
}

function asSymbol(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return clip(value.toUpperCase(), TICKER_MAX);
}

function asMarketTicker(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return clip(value.toUpperCase(), MARKET_TICKER_MAX);
}

/**
 * Resolve instrument. Explicit wins; otherwise legacy option legs (had `right`)
 * stay options, kalshi when market_ticker present, and side-only legs become equity.
 */
function resolveInstrument(rec: Record<string, unknown>): LegInstrument | null {
  if (typeof rec.instrument === "string" && INSTRUMENTS.has(rec.instrument as LegInstrument)) {
    return rec.instrument as LegInstrument;
  }
  if (asMarketTicker(rec.market_ticker)) return "kalshi";
  if (asRight(rec.right) || rec.strike != null || (typeof rec.strike_rel === "string" && rec.strike_rel.trim())) {
    return "option";
  }
  // Legacy payloads never emitted side-only legs; treat as equity for new stock ideas.
  if (asSide(rec.side)) return "equity";
  return null;
}

function normalizeOptionLeg(rec: Record<string, unknown>, side: TradeSide): OptionTradeLeg | null {
  const right = asRight(rec.right);
  if (!right) return null;

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
  const qty = asQty(rec.qty);
  const symbol = asSymbol(rec.symbol);

  return {
    instrument: "option",
    right,
    side,
    ...(strike != null ? { strike } : {}),
    ...(strike_rel ? { strike_rel } : {}),
    ...(expiration ? { expiration } : {}),
    ...(dte != null ? { dte } : {}),
    ...(qty != null ? { qty } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function normalizeEquityLeg(rec: Record<string, unknown>, side: TradeSide): EquityTradeLeg {
  const qty = asQty(rec.qty);
  const symbol = asSymbol(rec.symbol);
  return {
    instrument: "equity",
    side,
    ...(qty != null ? { qty } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function normalizeKalshiLeg(rec: Record<string, unknown>, side: TradeSide): KalshiTradeLeg | null {
  const market_ticker = asMarketTicker(rec.market_ticker);
  if (!market_ticker) return null;
  const contract_side = asContractSide(rec.contract_side) ?? "yes";
  const qty = asQty(rec.qty);
  const symbol = asSymbol(rec.symbol);
  return {
    instrument: "kalshi",
    side,
    market_ticker,
    contract_side,
    ...(qty != null ? { qty } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function normalizeLeg(raw: unknown): TradeLeg | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const side = asSide(rec.side);
  if (!side) return null;

  const instrument = resolveInstrument(rec);
  if (!instrument) return null;

  if (instrument === "equity") {
    return normalizeEquityLeg(rec, side);
  }
  if (instrument === "kalshi") {
    return normalizeKalshiLeg(rec, side);
  }
  return normalizeOptionLeg(rec, side);
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

/** Compact leg label for admin / debug strings. */
export function formatTradeLeg(leg: TradeLeg): string {
  const qty = leg.qty != null ? `${leg.qty} ` : "";
  const sym = leg.symbol ? ` ${leg.symbol}` : "";
  if (leg.instrument === "equity") {
    return `${leg.side} ${qty}shares${sym}`.replace(/\s+/g, " ").trim();
  }
  if (leg.instrument === "kalshi") {
    const side = leg.contract_side ?? "yes";
    return `${leg.side} ${qty}${side.toUpperCase()} ${leg.market_ticker}${sym}`
      .replace(/\s+/g, " ")
      .trim();
  }
  const strike = leg.strike != null
    ? String(leg.strike)
    : (leg.strike_rel ?? "?");
  const tenor = leg.expiration
    ? leg.expiration + (leg.dte != null ? ` (${leg.dte}d)` : "")
    : (leg.dte != null ? `${leg.dte}d` : "");
  const body = `${leg.side} ${qty}${strike} ${leg.right}${sym}`;
  return `${body.replace(/\s+/g, " ").trim()}${tenor ? ` · ${tenor}` : ""}`;
}

export function isOptionLeg(leg: TradeLeg): leg is OptionTradeLeg {
  return leg.instrument === "option";
}

export function isEquityLeg(leg: TradeLeg): leg is EquityTradeLeg {
  return leg.instrument === "equity";
}

export function isKalshiLeg(leg: TradeLeg): leg is KalshiTradeLeg {
  return leg.instrument === "kalshi";
}

/** Prompt block: emit trades only via suggest_trades (no freeform parsing). */
export function tradesSuggestBlock(): string {
  return [
    "Suggested trades (structured — never freeform-only):",
    "- After publish_desk on ticker / trade analysis, MUST call suggest_trades before final prose. The UI renders trades from this tool only — do not bury legs in markdown.",
    "- Each trade needs ticker, bias (bullish|bearish|neutral), conviction (high|medium|low), structure label, and rationale grounded in shared evidence.",
    "- Prefer 1–2 defined-risk ideas. Include legs when evidence supports them. Each leg needs instrument (option|equity|kalshi) + side (buy|sell).",
    "- Option legs: right (call|put) + strike or strike_rel + expiration/dte. Absolute strikes/expiries MUST come from a prior option_contracts query with two-sided quotes (bid>0, ask>=bid), tight-ish spread, and volume/OI interest. Put that quote quality in liquidity.",
    "- Equity legs: stock or ETF shares of the trade ticker (or leg.symbol override). buy = long, sell = short. Optional qty = share count. Use for outright long/short, covered calls, collars, etc.",
    "- Kalshi legs: instrument=kalshi + market_ticker from options.kalshi_markets (curated Fed/CPI/index/crypto/oil series only) + optional contract_side yes|no (default yes). buy/sell is the Kalshi contract side. Prefer two-sided yes_bid/yes_ask with demonstrated volume. Trade ticker may be the related_symbol (SPY, TLT, BTC-USD) or the series_ticker (KXFED).",
    "- Optional qty on option/Kalshi legs = contract count. Prefer sized legs when the idea implies a unit.",
    "- If nothing is tradable, pass trades: [] (skip_reason optional). Never invent fills or far-OTM lottery tickets.",
    "- Do not publish a \"trim single-holding / single-name concentration\" equity sell on a diversified ETF or index fund. Identify the ticker (book description or lookup_symbols, including top holdings/weights) first; sleeve size is not issuer concentration. Check constituent weights before calling a fund a single name.",
    "- After suggest_trades, final message text stays the desk overview only (1–4 sentences). Do not re-list the trades in prose.",
  ].join("\n");
}
