/**
 * Select which desk specialists must publish for a user question.
 * Overview is always required separately; this only picks specialist panels.
 *
 * Default desk is fundamental + technical + options + risk. Macro is additive
 * when the ask warrants it — a GME options-chain dig does not pull macro;
 * SPY / TLT / Fed / rates questions do. Risk always publishes so the Analyst
 * desk has a downside / sizing / thesis-break take on every analysis turn.
 */

import { DESK_VIEWPOINT_IDS, type DeskViewpointId } from "./copilot-desk";

/** Broad-market / rates / factor ETFs and indexes that usually want a macro take. */
export const MACRO_UNDERLYINGS = new Set([
  "SPY",
  "SPX",
  "QQQ",
  "NDX",
  "IWM",
  "RUT",
  "DIA",
  "DJX",
  "VIX",
  "VVIX",
  "VIX9D",
  "VIX3M",
  "SKEW",
  "VXN",
  "TLT",
  "IEF",
  "IEI",
  "SHY",
  "GOVT",
  "AGG",
  "BND",
  "LQD",
  "HYG",
  "JNK",
  "TIP",
  "GLD",
  "SLV",
  "USO",
  "UNG",
  "UUP",
  "FXE",
  "FXY",
  "VT",
  "EFA",
  "EEM",
  "VWO",
  "XLF",
  "XLE",
  "XLK",
  "XLU",
  "XLI",
  "XLP",
  "XLV",
  "XLY",
  "XLB",
  "XLRE",
  "SMH",
  "KRE",
  "IYR",
  "UVXY",
  "SVXY",
  "VXX",
  "ES=F",
  "NQ=F",
  "RTY=F",
  "YM=F",
  "ZN=F",
  "ZB=F",
  "ZF=F",
  "ZT=F",
  "CL=F",
  "GC=F",
  "SI=F",
  "DX-Y.NYB",
]);

const STOP_WORDS = new Set([
  "A", "AN", "THE", "AND", "OR", "FOR", "ON", "IN", "TO", "OF", "IS", "IT", "AT",
  "BY", "BE", "AS", "IF", "SO", "DO", "WE", "ME", "MY", "UP", "OUT", "ALL", "ANY",
  "CAN", "WAS", "ARE", "NOT", "BUT", "HOW", "WHY", "WHAT", "WHEN", "WHO", "WITH",
  "FROM", "THIS", "THAT", "YOUR", "YOU", "HAS", "HAVE", "HAD", "WILL", "JUST",
  "INTO", "OVER", "THAN", "THEN", "ALSO", "ONLY", "MORE", "MOST", "SOME", "SUCH",
  "ABOUT", "AFTER", "BEFORE", "UNDER", "ABOVE", "BETWEEN", "THROUGH", "DURING",
  "SHOW", "GIVE", "TELL", "LOOK", "NEED", "WANT", "LIKE", "TAKE", "GET", "SEE",
  "HELP", "PLEASE", "TODAY", "NOW", "NEXT", "LAST", "WEEK", "MONTH", "YEAR",
  "PRICE", "STOCK", "SHARE", "SHARES", "MARKET", "TRADE", "TRADES", "CHART",
  "DATA", "QUERY", "SQL", "TABLE", "LAKE", "CALL", "PUT", "CALLS", "PUTS",
]);

const MACRO_KEYWORD_RE =
  /\b(fed|fomc|beige book|cpi|ppi|nfp|nonfarm|payrolls?|gdp|inflation|disinflation|recession|soft landing|rates?|yields?|treasury|treasuries|duration|macro|risk[- ]?on|risk[- ]?off|dollar|dxy|crude|geopolit|breadth|sector rotation|rates market|bond market)\b/i;

const RISK_KEYWORD_RE =
  /\b(risk|hedge|hedging|drawdown|wipeout|position siz(?:e|ing)|stop[- ]?loss|downside|tail risk|gamma squeeze|assignment|max loss|defined[- ]risk|leverage|margin|blow[- ]?up|ruin|stress test|what could go wrong|worst case)\b/i;

const OPTIONS_KEYWORD_RE =
  /\b(options?|chain|iv\b|implied vol(?:atility)?|skew|straddle|strangle|debit spread|credit spread|iron condor|butterfly|dte|greeks?|open interest|\boi\b|premium|occ)\b/i;

const FUNDAMENTAL_KEYWORD_RE =
  /\b(earnings?|fundamental|filings?|10[- ]?[kq]|guidance|revenue|eps|valuation|peers?|catalyst|balance sheet|margins?|buyback|dividend)\b/i;

const DEFAULT_DESK: DeskViewpointId[] = ["fundamental", "technical", "options", "risk"];

/** Extract ticker-like tokens from a user question (best-effort). */
export function extractMentionedSymbols(question: string): string[] {
  const found = new Set<string>();
  const text = question.trim();
  if (!text) return [];

  for (const match of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    found.add(match[1].toUpperCase());
  }
  for (const match of text.matchAll(/\^([A-Za-z0-9]{1,6})\b/g)) {
    found.add(`^${match[1].toUpperCase()}`);
  }
  for (const match of text.matchAll(/\b([A-Za-z]{1,5})-USD\b/gi)) {
    found.add(`${match[1].toUpperCase()}-USD`);
  }
  for (const match of text.matchAll(/\b([A-Za-z]{1,5})=F\b/gi)) {
    found.add(`${match[1].toUpperCase()}=F`);
  }

  // Bare symbols: match known macro underlyings as whole words, plus $-free
  // uppercase tickers (GME, AAPL) that aren't stop words.
  const upper = text.toUpperCase();
  for (const symbol of MACRO_UNDERLYINGS) {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:[^A-Z0-9]|$)`).test(upper)) {
      found.add(symbol);
    }
  }
  for (const match of text.matchAll(/\b([A-Z]{1,5})\b/g)) {
    const token = match[1];
    if (STOP_WORDS.has(token) || MACRO_UNDERLYINGS.has(token)) continue;
    found.add(token);
  }
  // Lowercase single-name mentions next to options/stock language ("gme options").
  if (OPTIONS_KEYWORD_RE.test(text) || /\b(stock|shares|ticker|analyze|analysis)\b/i.test(text)) {
    for (const match of text.matchAll(/\b([a-z]{1,5})\b/g)) {
      const token = match[1].toUpperCase();
      if (STOP_WORDS.has(token) || token.length < 2) continue;
      if (MACRO_UNDERLYINGS.has(token) || /^[A-Z]{1,5}$/.test(token)) found.add(token);
    }
  }

  return [...found];
}

export function questionWantsMacro(question: string): boolean {
  if (MACRO_KEYWORD_RE.test(question)) return true;
  return extractMentionedSymbols(question).some((symbol) => {
    const base = symbol.replace(/^\^/, "");
    return MACRO_UNDERLYINGS.has(symbol) || MACRO_UNDERLYINGS.has(base);
  });
}

export function questionWantsRisk(question: string): boolean {
  return RISK_KEYWORD_RE.test(question)
    || /\b(trade ideas?|suggest(?:ed)? trades?|structure a|how (?:do|would) i hedge)\b/i.test(question);
}

/**
 * Stable-ordered specialist list for this turn.
 * Pure options-tape asks on a single name keep F+T+O+R without macro.
 * Broad ETF / rates / Fed asks add macro. Risk is always required.
 * `context` is extra routing text (user reply note, or bot persona +
 * system_prompt_extra) so a short audience note or a rates bot still
 * publishes the macro panel without stuffing the question.
 */
export function selectDeskSpecialists(question: string, context?: string): DeskViewpointId[] {
  const q = [question, context].filter((part) => typeof part === "string" && part.trim()).join("\n").trim();
  if (!q) return [...DEFAULT_DESK];

  const symbols = extractMentionedSymbols(q);
  const wantsMacro = questionWantsMacro(q);
  const fundamentalFocus = FUNDAMENTAL_KEYWORD_RE.test(q);
  const hasSingleName = symbols.some((symbol) => {
    const base = symbol.replace(/^\^/, "");
    return !MACRO_UNDERLYINGS.has(symbol) && !MACRO_UNDERLYINGS.has(base);
  });
  const hasMacroUnderlying = symbols.some((symbol) => {
    const base = symbol.replace(/^\^/, "");
    return MACRO_UNDERLYINGS.has(symbol) || MACRO_UNDERLYINGS.has(base);
  });

  // Pure broad-market / rates tape with no single-name: macro + technical,
  // plus options when vol/options language is present; skip equity fundamentals.
  const pureMacroTape = wantsMacro && !hasSingleName && !fundamentalFocus
    && (hasMacroUnderlying || MACRO_KEYWORD_RE.test(q));

  const selected = new Set<DeskViewpointId>();

  if (pureMacroTape) {
    // Index/ETF / rates tape: macro + technical + options + risk; skip equity fundamentals.
    selected.add("macro");
    selected.add("technical");
    selected.add("options");
  } else {
    selected.add("fundamental");
    selected.add("technical");
    selected.add("options");
    if (wantsMacro) selected.add("macro");
  }

  // Risk is a core desk voice — always publish downside / sizing / what-breaks.
  selected.add("risk");

  return DESK_VIEWPOINT_IDS.filter((id) => selected.has(id));
}
