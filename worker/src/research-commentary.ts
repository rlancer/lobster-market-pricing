/**
 * Lobster commentary for a ticker detail page.
 *
 * Grounded in the cached research brief. Prefers a short LLM take in brand
 * voice; falls back to a deterministic synthesis from price/technicals so the
 * page always has something numbers-first when OpenRouter is unavailable.
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

export type CommentarySource = "llm" | "notes";

export interface TickerCommentary {
  ticker: string;
  security_id: string;
  commentary: string;
  source: CommentarySource;
  computed_at: string;
  cache_hit: boolean;
}

export const COMMENTARY_SYSTEM = [
  "You are Lobster MP — a senior quant Copilot for US equities and ETF options.",
  "Write a 2–4 sentence ticker takeaway for a detail page.",
  "Lead with the spot or the move that matters. Ground every claim in the brief.",
  "Sound smug-confident and precise — no fluff, no anthropomorphizing, no emoji.",
  "Do not invent prices, news, or fundamentals that are not in the brief.",
  "Do not mention being an AI or that this is a summary. No hedging every clause.",
].join("\n");

/** Deterministic Lobster-voice blurb from structured research (always available). */
export function synthesizeCommentary(r: TickerResearch): string {
  const ticker = r.identity.ticker;
  const bits: string[] = [];

  if (r.price.spot != null) {
    const chg =
      r.price.change_1d_pct != null
        ? ` (${r.price.change_1d_pct >= 0 ? "+" : ""}${r.price.change_1d_pct.toFixed(1)}% 1d)`
        : "";
    bits.push(`${ticker} marks ${fmtSpot(r.price.spot)}${chg}.`);
  } else {
    bits.push(`${ticker}: no lake spot yet.`);
  }

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
  if (posture.length) bits.push(`Price action: ${posture.join(", ")}.`);

  const note = r.technicals.notes[0];
  if (note && !bits.some((b) => b.includes(note.slice(0, 24)))) {
    bits.push(note.endsWith(".") ? note : `${note}.`);
  }

  if (r.fundamentals.trailing_pe != null || r.fundamentals.market_cap != null) {
    const fund: string[] = [];
    if (r.fundamentals.market_cap != null) fund.push(`mkt cap ${fmtNum(r.fundamentals.market_cap)}`);
    if (r.fundamentals.trailing_pe != null) fund.push(`trailing P/E ${r.fundamentals.trailing_pe.toFixed(1)}`);
    bits.push(`Fundamentals: ${fund.join(", ")}.`);
  }

  if (r.earnings[0]) {
    const e = r.earnings[0];
    bits.push(
      `Next/recent earnings ${e.earnings_date}${e.eps_forecast != null ? ` (EPS est ${e.eps_forecast})` : ""}.`,
    );
  }

  return bits.slice(0, 4).join(" ");
}

export async function generateLobsterCommentary(
  research: TickerResearch,
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<string | null> {
  try {
    const brief = compactBriefForPrompt(research);
    const result = await generateText({
      model,
      system: COMMENTARY_SYSTEM,
      prompt: `Write the Lobster take for this ticker brief:\n\n${brief}`,
      maxOutputTokens: 220,
      temperature: 0.3,
      abortSignal: opts?.abortSignal,
    });
    const text = result.text.trim();
    if (!text || text.length < 24) return null;
    // Keep the page readable — strip accidental markdown fences.
    return text.replace(/^```[\s\S]*?```$/g, "").replace(/^["']|["']$/g, "").trim();
  } catch (error) {
    console.warn(JSON.stringify({
      researchCommentary: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
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
 * through when absent. Always succeeds with at least notes synthesis.
 */
export async function getOrComputeCommentary(
  env: ResearchEnv,
  rawTicker: string,
  deps: CommentaryDeps,
  opts?: { force?: boolean },
): Promise<TickerCommentary> {
  const now = deps.now?.() ?? Date.now();
  const research = await getOrComputeResearch(env, rawTicker, deps, { force: false });

  if (!opts?.force && research.commentary?.trim()) {
    return {
      ticker: research.identity.ticker,
      security_id: research.identity.security_id,
      commentary: research.commentary.trim(),
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
