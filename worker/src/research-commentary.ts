/**
 * Lobster commentary for a ticker detail page.
 *
 * Grounded in the cached research brief. Prefers a short LLM take in brand
 * voice; falls back to a deterministic synthesis from price/technicals when
 * OpenRouter is unavailable. When the brief has no usable price/signal data,
 * return an explicit "not enough data" message instead of inventing a take.
 *
 * Takes with enough data include an explicit directional bias and a concrete
 * options structure (low conviction is fine when signals are mixed).
 */

import { generateText, type LanguageModel } from "ai";
import {
  getOrComputeResearch,
  writeResearchCache,
  RESEARCH_TTL_MS,
  type ResearchDeps,
  type ResearchEnv,
  type TickerResearch,
} from "./research";

export type CommentarySource = "llm" | "notes" | "insufficient";

export type TradeBias = "bullish" | "bearish" | "neutral";

export interface TradeIdea {
  bias: TradeBias;
  /** Low when signals conflict or data is soft; still picks a lean when data exists. */
  conviction: "high" | "medium" | "low";
  /** One-line structure suggestion (relative strikes / DTE, no invented premiums). */
  structure: string;
  /** Short rationale tying the structure to the brief. */
  rationale: string;
}

export interface TickerCommentary {
  ticker: string;
  security_id: string;
  commentary: string;
  source: CommentarySource;
  computed_at: string;
  cache_hit: boolean;
}

export const COMMENTARY_SYSTEM = [
  "You are Lobster MP — a senior quant Copilot for US equities, ETF options, indexes, futures, and spot crypto OHLC.",
  "Write a short ticker takeaway for a detail page in Markdown.",
  "Use short paragraphs (1–2 sentences each) separated by blank lines — never one long wall of text.",
  "Lead with the spot or the move that matters. Ground every claim in the brief.",
  "Close with a Trade section exactly in this shape:",
  "**Trade — {Bullish|Bearish|Neutral} ({high|medium|low} conviction)**",
  "Then one short line naming the structure (e.g. bull call debit spread, put debit, iron condor, calendar), rough tenor (e.g. 30–45 DTE), and strike posture relative to spot (ATM / ~5% OTM / wings).",
  "If signals are mixed or do not support a high-conviction trade, pick a lean, say conviction is low, and suggest a defined-risk structure.",
  "Prefer defined-risk over naked short options. Near earnings, favor defined-risk or calendars and call out event risk.",
  "Suggested structures must be tradable: prefer near-spot strikes and standard 21–45 DTE tenors on names with real volume in the brief. Do not recommend far-OTM or exotic wings on thin names. If volume looks weak, say so and keep conviction low.",
  "Do not invent strike prices, premiums, IV ranks, or news not in the brief — describe strikes relative to spot only.",
  "Markdown only: blank-line paragraphs, **bold** for the Trade header, optional bullets. No code fences, no tables, no headings (#), no emoji.",
  "Sound smug-confident and precise — no fluff, no anthropomorphizing.",
  "Do not mention being an AI or that this is a summary. No hedging every clause.",
].join("\n");

/** True when the brief has enough price/signal grounding for a take or trade lean. */
export function hasEnoughDataForCommentary(r: TickerResearch): boolean {
  return !isThinBrief(r);
}

/** Spot missing, or no trend/flow/horizon move to lean on. */
export function isThinBrief(r: TickerResearch): boolean {
  const { trend, accumulation } = r.technicals;
  const chg5 = r.price.change_5d_pct;
  const chg21 = r.price.change_21d_pct;
  return (
    r.price.spot == null
    || (trend === "unknown" && accumulation === "unknown" && chg5 == null && chg21 == null)
  );
}

export function formatInsufficientDataCommentary(r: TickerResearch): string {
  return `Not enough data yet to form a take on ${r.identity.ticker}.`;
}

export function looksLikeInsufficientDataCommentary(text: string): boolean {
  return /^not enough data\b/i.test(text.trim());
}

/**
 * Drop force-fed trade takes from thin briefs (and clear stale insufficient
 * messages once the lake has filled in) so the research payload never ships a
 * fake lean.
 */
export function sanitizeResearchCommentary(r: TickerResearch): TickerResearch {
  const cached = r.commentary?.trim() ?? "";
  if (!cached) return r;

  if (!hasEnoughDataForCommentary(r)) {
    if (looksLikeInsufficientDataCommentary(cached)) return r;
    return {
      ...r,
      commentary: formatInsufficientDataCommentary(r),
      commentary_source: "insufficient",
    };
  }

  if (looksLikeInsufficientDataCommentary(cached)) {
    return {
      ...r,
      commentary: null,
      commentary_source: null,
      commentary_computed_at: null,
    };
  }
  return r;
}

/**
 * Deterministic directional lean + options structure from the brief.
 * Caller should only use this when hasEnoughDataForCommentary is true.
 */
export function suggestTradeIdea(r: TickerResearch): TradeIdea {
  const { trend, consolidation, accumulation } = r.technicals;
  const chg5 = r.price.change_5d_pct;
  const chg21 = r.price.change_21d_pct;
  const volRel = r.price.volume_relative_20d;
  const earningsSoon = isEarningsSoon(r);
  const thin = isThinBrief(r);

  let biasScore = 0;
  if (trend === "up") biasScore += 2;
  if (trend === "down") biasScore -= 2;
  if (accumulation === "accumulating") biasScore += 1;
  if (accumulation === "distributing") biasScore -= 1;
  if (chg5 != null) {
    if (chg5 >= 3) biasScore += 1;
    else if (chg5 <= -3) biasScore -= 1;
  }
  if (chg21 != null) {
    if (chg21 >= 5) biasScore += 1;
    else if (chg21 <= -5) biasScore -= 1;
  }

  let bias: TradeBias;
  if (biasScore >= 2) bias = "bullish";
  else if (biasScore <= -2) bias = "bearish";
  else if (consolidation || trend === "sideways") bias = "neutral";
  else if (biasScore > 0) bias = "bullish";
  else if (biasScore < 0) bias = "bearish";
  else bias = "neutral";

  const signalCount =
    (trend !== "unknown" ? 1 : 0) +
    (accumulation === "accumulating" || accumulation === "distributing" ? 1 : 0) +
    (chg5 != null && Math.abs(chg5) >= 3 ? 1 : 0) +
    (consolidation ? 1 : 0);

  let conviction: TradeIdea["conviction"] = "medium";
  if (thin || signalCount === 0 || Math.abs(biasScore) <= 1) conviction = "low";
  else if (Math.abs(biasScore) >= 3 && signalCount >= 2) conviction = "high";

  // Conflicting trend vs flow softens conviction.
  if (
    (trend === "up" && accumulation === "distributing") ||
    (trend === "down" && accumulation === "accumulating")
  ) {
    conviction = "low";
  }

  const hotVol = volRel != null && volRel >= 1.5;
  const structure = pickStructure(bias, {
    consolidation,
    earningsSoon,
    hotVol,
    thin,
  });

  const rationale = buildRationale(r, bias, conviction, {
    consolidation,
    earningsSoon,
    thin,
  });

  return { bias, conviction, structure, rationale };
}

function pickStructure(
  bias: TradeBias,
  ctx: { consolidation: boolean; earningsSoon: boolean; hotVol: boolean; thin: boolean },
): string {
  if (ctx.earningsSoon) {
    if (bias === "bullish") {
      return "defined-risk call debit or bull call spread ~30–45 DTE, sized for event gamma (or a post-print calendar if you want to fade the IV crush)";
    }
    if (bias === "bearish") {
      return "defined-risk put debit or bear put spread ~30–45 DTE into the print — avoid naked short gamma into earnings";
    }
    return "iron butterfly / tight iron condor ~21–35 DTE centered near spot, or sit cash and buy the post-earnings IV crush with a calendar";
  }

  if (ctx.thin) {
    if (bias === "bullish") {
      return "small ATM–5% OTM call debit ~45 DTE (probe size) until the lake fills in";
    }
    if (bias === "bearish") {
      return "small ATM–5% OTM put debit ~45 DTE (probe size) until the lake fills in";
    }
    return "wait for a spot print, or a 1-lot iron condor ~30 DTE as a placeholder range bet";
  }

  if (bias === "bullish") {
    if (ctx.consolidation) {
      return "bull call debit spread ~30–45 DTE (long ATM / short ~5–8% OTM) for a consolidation breakout";
    }
    return ctx.hotVol
      ? "bull call debit spread ~30–45 DTE (long ~ATM / short ~5% OTM) — prefer spread over naked calls with elevated volume"
      : "call debit ~30–45 DTE ~ATM to 5% OTM, or a bull call spread if you want cheaper carry";
  }

  if (bias === "bearish") {
    if (ctx.consolidation) {
      return "bear put debit spread ~30–45 DTE (long ATM / short ~5–8% OTM) for a downside break";
    }
    return ctx.hotVol
      ? "bear put debit spread ~30–45 DTE — prefer defined risk while volume is elevated"
      : "put debit ~30–45 DTE ~ATM to 5% OTM, or a bear put spread for cleaner R:R";
  }

  // Neutral
  if (ctx.consolidation) {
    return "short iron condor ~21–45 DTE with wings outside the recent 20d range (or a long straddle if you want the breakout instead)";
  }
  return "iron condor ~30–45 DTE centered near spot, or a calendar spread if you expect quiet spot and decaying front IV";
}

function buildRationale(
  r: TickerResearch,
  bias: TradeBias,
  conviction: TradeIdea["conviction"],
  ctx: { consolidation: boolean; earningsSoon: boolean; thin: boolean },
): string {
  const parts: string[] = [];
  if (ctx.thin) {
    parts.push("brief is thin");
  } else {
    if (r.technicals.trend !== "unknown") parts.push(`${r.technicals.trend} trend`);
    if (r.technicals.accumulation === "accumulating" || r.technicals.accumulation === "distributing") {
      parts.push(r.technicals.accumulation);
    }
    if (ctx.consolidation) parts.push("tight range");
  }
  if (ctx.earningsSoon && r.earnings[0]) {
    parts.push(`earnings ${r.earnings[0].earnings_date}`);
  }
  const why = parts.length ? parts.join(", ") : "mixed tape";
  return `${conviction} conviction ${bias} lean (${why})`;
}

function isEarningsSoon(r: TickerResearch): boolean {
  const date = r.earnings[0]?.earnings_date;
  if (!date) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  const now = Date.parse(r.computed_at) || Date.now();
  const days = (t - now) / (24 * 60 * 60 * 1000);
  // Treat as "soon" if within ~21 days forward or up to 1 day past (just reported window).
  return days >= -1 && days <= 21;
}

/** Format the trade idea as the closing Markdown Trade section. */
export function formatTradeIdea(idea: TradeIdea): string {
  const biasLabel =
    idea.bias === "bullish" ? "Bullish" : idea.bias === "bearish" ? "Bearish" : "Neutral";
  const conf =
    idea.conviction === "high"
      ? "high conviction"
      : idea.conviction === "medium"
        ? "medium conviction"
        : "low conviction — data is soft, but a lean beats a shrug";
  const structure = idea.structure.endsWith(".") ? idea.structure : `${idea.structure}.`;
  return `**Trade — ${biasLabel} (${conf})**\n${structure}`;
}

/**
 * Deterministic Lobster-voice blurb from structured research.
 * Thin briefs return the insufficient-data message — no invented lean.
 */
export function synthesizeCommentary(r: TickerResearch): string {
  if (!hasEnoughDataForCommentary(r)) {
    return formatInsufficientDataCommentary(r);
  }

  const ticker = r.identity.ticker;
  const paragraphs: string[] = [];

  if (r.price.spot != null) {
    const chg =
      r.price.change_1d_pct != null
        ? ` (${r.price.change_1d_pct >= 0 ? "+" : ""}${r.price.change_1d_pct.toFixed(1)}% 1d)`
        : "";
    const posture: string[] = [];
    if (r.technicals.trend !== "unknown") posture.push(`${r.technicals.trend} trend`);
    if (r.technicals.consolidation) {
      posture.push(
        r.technicals.consolidation_range_pct != null
          ? `consolidating (${r.technicals.consolidation_range_pct.toFixed(1)}% 20d range)`
          : "consolidating",
      );
    }
    if (r.technicals.accumulation === "accumulating" || r.technicals.accumulation === "distributing") {
      posture.push(r.technicals.accumulation);
    }
    paragraphs.push(
      posture.length
        ? `${ticker} marks ${fmtSpot(r.price.spot)}${chg} — ${posture.join(", ")}.`
        : `${ticker} marks ${fmtSpot(r.price.spot)}${chg}.`,
    );
  }

  const note = r.technicals.notes[0];
  if (note) {
    const noteText = note.endsWith(".") ? note : `${note}.`;
    if (!paragraphs.some((p) => p.includes(note.slice(0, 24)))) {
      paragraphs.push(noteText);
    }
  }

  const fundBits: string[] = [];
  if (r.fundamentals.market_cap != null) fundBits.push(`mkt cap ${fmtNum(r.fundamentals.market_cap)}`);
  if (r.fundamentals.trailing_pe != null) fundBits.push(`trailing P/E ${r.fundamentals.trailing_pe.toFixed(1)}`);
  if (r.earnings[0]) {
    const e = r.earnings[0];
    fundBits.push(
      `earnings ${e.earnings_date}${e.eps_forecast != null ? ` (EPS est ${e.eps_forecast})` : ""}`,
    );
  }
  const s = r.shorting;
  if (s?.days_to_cover != null) fundBits.push(`days to cover ${s.days_to_cover.toFixed(1)}`);
  if (s?.short_ratio != null) fundBits.push(`short vol ${(s.short_ratio * 100).toFixed(0)}%`);
  if (fundBits.length) paragraphs.push(`${fundBits.join(" · ")}.`);

  // Keep the recap tight; always keep the trade closer last.
  const idea = suggestTradeIdea(r);
  return [...paragraphs.slice(0, 3), formatTradeIdea(idea)].join("\n\n");
}

export async function generateLobsterCommentary(
  research: TickerResearch,
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<string | null> {
  try {
    const brief = compactBriefForPrompt(research);
    const idea = suggestTradeIdea(research);
    const result = await generateText({
      model,
      system: COMMENTARY_SYSTEM,
      prompt: [
        "Write the Lobster take for this ticker brief in Markdown (short paragraphs + Trade section).",
        "You must include a directional bias and a concrete options trade suggestion.",
        `Deterministic lean to honor unless the brief clearly contradicts it: ${idea.bias} (${idea.conviction}) → ${idea.structure}`,
        "",
        brief,
      ].join("\n"),
      maxOutputTokens: 480,
      temperature: 0.35,
      abortSignal: opts?.abortSignal,
    });
    const text = result.text.trim();
    if (!text || text.length < 24) return null;
    // Keep the page readable — strip accidental markdown fences / quotes.
    const cleaned = text
      .replace(/^```(?:markdown|md)?\s*/i, "")
      .replace(/```$/g, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    // If the model skipped the trade ask, append the deterministic closer.
    if (!looksLikeTradeTake(cleaned)) {
      return `${cleaned}\n\n${formatTradeIdea(idea)}`.trim();
    }
    return cleaned;
  } catch (error) {
    console.warn(JSON.stringify({
      researchCommentary: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

/** Heuristic: did the model actually propose a structure / bias? */
function looksLikeTradeTake(text: string): boolean {
  return /\b(bullish|bearish|neutral|call|put|spread|condor|straddle|strangle|calendar|debit|credit)\b/i.test(
    text,
  );
}

/**
 * Format v2 commentary: multi-paragraph Markdown with an explicit Trade section.
 * Single-line legacy blurbs miss this and get regenerated.
 */
export function looksLikeStructuredCommentary(text: string): boolean {
  return /\*\*Trade\b/i.test(text) && /\n/.test(text);
}

function compactBriefForPrompt(r: TickerResearch): string {
  const lines = [
    `${r.identity.ticker}${r.identity.name ? ` — ${r.identity.name}` : ""}`,
    r.identity.sector ? `Sector: ${r.identity.sector}` : null,
    r.price.spot != null ? `Spot: ${r.price.spot}` : null,
    r.price.change_1d_pct != null ? `1d: ${fmtPct(r.price.change_1d_pct)}` : null,
    r.price.change_5d_pct != null ? `5d: ${fmtPct(r.price.change_5d_pct)}` : null,
    r.price.change_21d_pct != null ? `21d: ${fmtPct(r.price.change_21d_pct)}` : null,
    r.price.volume_relative_20d != null
      ? `Vol vs 20d: ${(r.price.volume_relative_20d * 100).toFixed(0)}%`
      : null,
    `Trend: ${r.technicals.trend}; consolidation=${r.technicals.consolidation}; flow=${r.technicals.accumulation}`,
    ...r.technicals.notes.slice(0, 4).map((n) => `- ${n}`),
    r.fundamentals.market_cap != null ? `Market cap: ${r.fundamentals.market_cap}` : null,
    r.fundamentals.trailing_pe != null ? `Trailing P/E: ${r.fundamentals.trailing_pe}` : null,
    r.earnings[0]
      ? `Earnings: ${r.earnings[0].earnings_date}${r.earnings[0].eps_forecast != null ? ` EPS est ${r.earnings[0].eps_forecast}` : ""}`
      : null,
    ...r.news.slice(0, 3).map((n) => `News: ${n.title}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export interface CommentaryDeps extends ResearchDeps {
  /** Optional LLM; when missing or failing, notes synthesis is used. */
  createModel?: () => LanguageModel | null;
  now?: () => number;
}

/**
 * Return cached Lobster commentary for a ticker, generating and writing it
 * through when absent. Thin briefs get an explicit insufficient-data message
 * (never an invented trade lean). Otherwise LLM → notes synthesis.
 */
export async function getOrComputeCommentary(
  env: ResearchEnv,
  rawTicker: string,
  deps: CommentaryDeps,
  opts?: { force?: boolean },
): Promise<TickerCommentary> {
  const now = deps.now?.() ?? Date.now();
  const research = await getOrComputeResearch(env, rawTicker, deps, { force: false });

  const cached = research.commentary?.trim() ?? "";
  const enough = hasEnoughDataForCommentary(research);

  // Thin brief: never serve a force-fed trade take. Cache-hit only when the
  // stored message is already the insufficient-data copy.
  if (!enough) {
    const commentary = formatInsufficientDataCommentary(research);
    if (
      !opts?.force
      && cached
      && looksLikeInsufficientDataCommentary(cached)
    ) {
      return {
        ticker: research.identity.ticker,
        security_id: research.identity.security_id,
        commentary: cached,
        source: "insufficient",
        computed_at: research.commentary_computed_at ?? research.computed_at,
        cache_hit: true,
      };
    }
    return persistCommentary(env, research, commentary, "insufficient", now);
  }

  // Skip stale caches: pre-trade blurbs, insufficient placeholders, and
  // pre-markdown single walls of text.
  if (
    !opts?.force
    && cached
    && !looksLikeInsufficientDataCommentary(cached)
    && looksLikeTradeTake(cached)
    && looksLikeStructuredCommentary(cached)
  ) {
    return {
      ticker: research.identity.ticker,
      security_id: research.identity.security_id,
      commentary: cached,
      source: research.commentary_source === "llm" ? "llm" : "notes",
      computed_at: research.commentary_computed_at ?? research.computed_at,
      cache_hit: true,
    };
  }

  let commentary: string | null = null;
  let source: CommentarySource = "notes";
  const model = deps.createModel?.() ?? null;
  if (model) {
    commentary = await generateLobsterCommentary(research, model);
    if (commentary) source = "llm";
  }
  if (!commentary) {
    commentary = synthesizeCommentary(research);
    source = "notes";
  }

  return persistCommentary(env, research, commentary, source, now);
}

async function persistCommentary(
  env: ResearchEnv,
  research: TickerResearch,
  commentary: string,
  source: CommentarySource,
  now: number,
): Promise<TickerCommentary> {
  const computedAt = new Date(now).toISOString();
  const enriched: TickerResearch = {
    ...research,
    commentary,
    commentary_source: source,
    commentary_computed_at: computedAt,
    cache_hit: false,
  };

  // Keep the research TTL clock; only refresh payload so commentary rides along.
  const expiresAt = Date.parse(research.expires_at);
  const ttl = Number.isFinite(expiresAt) && expiresAt > now
    ? expiresAt
    : now + RESEARCH_TTL_MS;
  try {
    await writeResearchCache(env.SCHEMA_DB, enriched, ttl);
  } catch (e) {
    console.error("commentary cache write failed", e);
  }

  return {
    ticker: research.identity.ticker,
    security_id: research.identity.security_id,
    commentary,
    source,
    computed_at: computedAt,
    cache_hit: false,
  };
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtSpot(v: number): string {
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return v.toFixed(2);
}
