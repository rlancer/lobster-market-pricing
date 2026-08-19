/**
 * Cheap-model chat meta: short display title + ticker NER.
 *
 * Clip-of-first-user is the sync fallback; after a turn (or at share mint)
 * a flash OpenRouter call proposes a headline and tickers. Tickers flow
 * through resolveTickerIdentity → linkChatTicker (same graph as research_ticker).
 */
import { generateText, type LanguageModel } from "ai";
import { linkChatTicker } from "./chat-tickers";
import { resolveTickerIdentity, type FigiEnv } from "./figi";
import { parseTickerParam } from "./research";
import { clipTitle, firstUserContent, isAutoDerivedTitle, TITLE_MAX } from "./user-chats";

export const CHAT_META_SYSTEM = [
  "You label one Lobster MP Copilot transcript (US equities & ETF options).",
  "Return ONLY a JSON object with keys title and tickers. No markdown fences.",
  'Example: {"title":"NVDA vol crush after earnings","tickers":["NVDA"]}',
  "title: a short display headline (max 80 characters). Capture the topic or desk takeaway — not prompt instructions, not a verbatim paste of the user message.",
  "tickers: OCC equity/ETF roots clearly discussed (e.g. SPY, QQQ, IWM, NVDA). These become public tags on the share and timeline. Include index forms like ^VIX when relevant. Max 8. Empty array if none.",
  "Prefer liquid underlyings over strikes or option symbols. Do not invent tickers.",
].join("\n");

const META_MAX_TRANSCRIPT_CHARS = 6_000;
const META_MAX_TICKERS = 8;
const META_TITLE_SOFT_MAX = 80;

export type ChatMeta = {
  title: string | null;
  tickers: string[];
};

type TranscriptTurn = {
  role?: string;
  content?: string;
};

/** Build a compact transcript for the meta model (roles + content only). */
export function formatChatMetaTranscript(messages: unknown, maxChars = META_MAX_TRANSCRIPT_CHARS): string {
  if (!Array.isArray(messages)) return "";
  const lines: string[] = [];
  for (const row of messages) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as TranscriptTurn;
    const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  const joined = lines.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

/** Parse model JSON into a sanitized ChatMeta. Exported for unit tests. */
export function parseChatMetaResponse(text: string): ChatMeta {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return { title: null, tickers: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { title: null, tickers: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { title: null, tickers: [] };
  const rec = raw as Record<string, unknown>;
  let title: string | null = null;
  if (typeof rec.title === "string" && rec.title.trim()) {
    title = clipTitle(rec.title, Math.min(TITLE_MAX, META_TITLE_SOFT_MAX));
  }
  const tickers: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(rec.tickers) ? rec.tickers : [];
  for (const item of list) {
    if (tickers.length >= META_MAX_TICKERS) break;
    const parsed = parseTickerParam(typeof item === "string" ? item : String(item ?? ""));
    if (!parsed || seen.has(parsed)) continue;
    seen.add(parsed);
    tickers.push(parsed);
  }
  return { title, tickers };
}

/**
 * Ask a cheap model for title + tickers. Never throws — returns empty meta
 * on failure so callers keep the clipTitle fallback.
 */
export async function extractChatMeta(
  messages: unknown,
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<ChatMeta> {
  const transcript = formatChatMetaTranscript(messages);
  if (!transcript) return { title: null, tickers: [] };
  try {
    const result = await generateText({
      model,
      system: CHAT_META_SYSTEM,
      prompt: transcript,
      maxOutputTokens: 160,
      temperature: 0.2,
      abortSignal: opts?.abortSignal,
    });
    return parseChatMetaResponse(result.text);
  } catch (error) {
    console.warn(JSON.stringify({
      chatMeta: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { title: null, tickers: [] };
  }
}

export type ChatMetaEnv = FigiEnv & {
  SCHEMA_DB: D1Database;
};

/** Resolve NER tickers onto chat_tickers. Best-effort; never throws. */
export async function linkMetaTickers(
  env: ChatMetaEnv,
  chatId: string,
  tickers: string[],
): Promise<string[]> {
  const linked: string[] = [];
  for (const ticker of tickers) {
    try {
      const identity = await resolveTickerIdentity(env, ticker, { liveFigi: false });
      await linkChatTicker(env.SCHEMA_DB, chatId, identity);
      linked.push(identity.ticker);
    } catch (error) {
      console.warn("chat-meta ticker link failed", ticker, error);
    }
  }
  return linked;
}

/**
 * Full enrich: extract meta, link tickers, return title (LLM or clip fallback).
 */
export async function enrichChatMeta(
  env: ChatMetaEnv,
  chatId: string,
  messages: unknown,
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<{ title: string | null; tickers: string[] }> {
  const fallback = firstUserContent(messages);
  const meta = await extractChatMeta(messages, model, opts);
  const tickers = meta.tickers.length
    ? await linkMetaTickers(env, chatId, meta.tickers)
    : [];
  const title = meta.title || (fallback ? clipTitle(fallback) : null);
  return { title, tickers };
}

/**
 * Best-effort backfill for an existing share: NER tickers → chat_tickers tags,
 * and replace an auto-derived title with the LLM headline when appropriate.
 */
export async function backfillShareMeta(
  env: ChatMetaEnv & { OPEN_ROUTER_KEY?: string; COPILOT_MODEL?: string },
  args: {
    chatId: string;
    shareId: string;
    messages: unknown;
    storedTitle: string | null;
    model: LanguageModel;
  },
): Promise<void> {
  try {
    const meta = await enrichChatMeta(env, args.chatId, args.messages, args.model);
    const first = firstUserContent(args.messages);
    if (meta.title && isAutoDerivedTitle(args.storedTitle, first)) {
      await env.SCHEMA_DB.prepare(
        `UPDATE shared_chats SET title = ?1, updated_at = ?2 WHERE share_id = ?3`,
      ).bind(meta.title, Date.now(), args.shareId).run();
    }
  } catch (error) {
    console.warn("share meta backfill failed", error);
  }
}
