/**
 * EL5 (“explain like I’m 5”) rewrite of a public shared Copilot post.
 *
 * First viewer pays for one OpenRouter call; later viewers read D1.
 * source_hash (SHA-256 of the compact transcript) invalidates the cache
 * when a share is healed or re-snapshotted.
 */

import { generateText, type LanguageModel } from "ai";

export const EL5_SYSTEM = [
  "You rewrite one Lobster MP Copilot post so a five-year-old could follow the idea.",
  "Keep every ticker, number, date, and conclusion. Do not invent trades, fills, or news.",
  "When you hit jargon (IV, DTE, delta, spread, ATM, ITM, OTM, premium, short interest, Kalshi YES/NO, greeks), replace it with a tiny kid analogy in the same sentence, then keep going.",
  "Short Markdown paragraphs. No headings, no tables, no code fences, no emoji.",
  "Do not mention being an AI or that this is a translation.",
].join("\n");

export const EL5_MAX_SOURCE_CHARS = 8_000;
export const EL5_MAX_OUTPUT_TOKENS = 700;
export const EL5_RATE_WINDOW_MS = 10 * 60_000;
export const EL5_RATE_LIMIT = 20;

export const EL5_SHARE_ID_RE = /^[0-9A-Za-z]{1,48}$/;

export type El5Translation = {
  share_id: string;
  el5: string;
  cache_hit: boolean;
  computed_at: number;
  model: string | null;
};

export type El5CachedRow = {
  source_hash: string;
  el5_text: string;
  computed_at: number;
  model: string | null;
};

export type El5ShareRecord = {
  messages: unknown;
  title: string | null;
  expires_at: number | null;
};

export type El5Store = {
  readShare: (shareId: string) => Promise<El5ShareRecord | null>;
  readTranslation: (shareId: string) => Promise<El5CachedRow | null>;
  writeTranslation: (shareId: string, row: El5CachedRow) => Promise<void>;
};

export class El5Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "El5Error";
  }
}

type TranscriptTurn = {
  role?: string;
  content?: string;
  desk?: {
    overview?: string;
    fundamental?: string;
    technical?: string;
    options?: string;
    risk?: string;
    macro?: string;
  };
  trades?: {
    trades?: { ticker?: string; bias?: string; structure?: string; rationale?: string }[];
    skip_reason?: string;
  };
};

/** Compact the post into the text the model (and hash) see. */
export function formatEl5Source(
  messages: unknown,
  title: string | null,
  maxChars = EL5_MAX_SOURCE_CHARS,
): string {
  const lines: string[] = [];
  const headline = title?.trim();
  if (headline) lines.push(`title: ${headline}`);
  if (!Array.isArray(messages)) return clipSource(lines.join("\n\n"), maxChars);
  for (const row of messages) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as TranscriptTurn;
    const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
    if (!role) continue;
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (content) lines.push(`${role}: ${content}`);
    if (role === "assistant" && rec.desk) {
      const overview = rec.desk.overview?.trim();
      if (overview) lines.push(`desk overview: ${overview}`);
      for (const key of ["fundamental", "technical", "options", "risk", "macro"] as const) {
        const text = rec.desk[key]?.trim();
        if (text) lines.push(`desk ${key}: ${text}`);
      }
    }
    if (role === "assistant" && rec.trades) {
      const list = Array.isArray(rec.trades.trades) ? rec.trades.trades : [];
      for (const trade of list) {
        const bits = [
          trade.ticker?.trim(),
          trade.bias?.trim(),
          trade.structure?.trim(),
          trade.rationale?.trim(),
        ].filter(Boolean);
        if (bits.length) lines.push(`trade: ${bits.join(" — ")}`);
      }
      const skip = rec.trades.skip_reason?.trim();
      if (!list.length && skip) lines.push(`trade skip: ${skip}`);
    }
  }
  return clipSource(lines.join("\n\n"), maxChars);
}

function clipSource(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

export async function hashEl5Source(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cache hit only when the stored hash still matches this transcript. */
export function resolveEl5Cache(
  shareId: string,
  cached: El5CachedRow | null,
  sourceHash: string,
  force: boolean,
): El5Translation | null {
  if (force || !cached) return null;
  if (cached.source_hash !== sourceHash) return null;
  const text = cached.el5_text.trim();
  if (!text) return null;
  return {
    share_id: shareId,
    el5: text,
    cache_hit: true,
    computed_at: cached.computed_at,
    model: cached.model,
  };
}

export function cleanEl5Text(raw: string): string {
  return raw
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Deterministic EL5 when OpenRouter is down — same source, jargon glossed
 * in place. Cached like an LLM rewrite so the button never hard-fails.
 */
const EL5_JARGON_GLOSS: Array<[RegExp, string]> = [
  [/\bimplied vol(?:atility)?\b/gi, "how jumpy people think the price will be"],
  [/\brealized vol(?:atility)?\b/gi, "how jumpy the price actually was"],
  [/\bIV\b/g, "how jumpy people think the price will be"],
  [/\bRV30\b/g, "how jumpy the last month really was"],
  [/\bDTE\b/g, "days until the option ticket expires"],
  [/\bATM\b/g, "ATM (right around today’s price)"],
  [/\bITM\b/g, "already a winning ticket if you used it now"],
  [/\bOTM\b/g, "needs the price to move your way first"],
  [/\bopen interest\b/gi, "how many tickets are still out there"],
  [/\bOI\b/g, "how many tickets are still out there"],
  [/\bbid\/ask\b/gi, "what buyers will pay / what sellers want"],
  [/\bshort interest\b/gi, "how many people bet the price will fall"],
  [/\bmarket cap\b/gi, "the whole company’s price tag"],
  [/\bP\/E\b/g, "how many dollars you pay per dollar it earned"],
  [/\bdelta\b/gi, "how much the ticket wiggles when the stock moves $1"],
  [/\bpremium\b/gi, "what you pay for the ticket"],
  [/\bstrike\b/gi, "the magic number on the ticket"],
  [/\bcall(?:s)?\b/gi, "call (ticket that likes the price going up)"],
  [/\bput(?:s)?\b/gi, "put (ticket that likes the price going down)"],
  [/\bYES\b/g, "YES (betting it happens)"],
  [/\bNO\b/g, "NO (betting it doesn’t)"],
];

export function synthesizeEl5(source: string): string {
  let text = source
    .replace(/^title:\s*/gim, "**")
    .replace(/^user:\s*/gim, "\n\nSomeone asked:\n")
    .replace(/^assistant:\s*/gim, "\n\nThe lobster said:\n")
    .replace(/^desk overview:\s*/gim, "\n\nBig picture:\n")
    .replace(/^desk (\w+):\s*/gim, "\n\n$1 desk:\n")
    .replace(/^trade:\s*/gim, "\n\nTrade idea: ")
    .replace(/^trade skip:\s*/gim, "\n\nNo trade: ");
  for (const [pattern, gloss] of EL5_JARGON_GLOSS) {
    text = text.replace(pattern, gloss);
  }
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "Nothing to explain yet.";
  return [
    "Here’s the simple version (jargon swapped for kid words):",
    "",
    text.slice(0, 4_000),
  ].join("\n");
}

export async function generateEl5Text(
  source: string,
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<{ text: string | null; error: string | null }> {
  try {
    const result = await generateText({
      model,
      system: EL5_SYSTEM,
      prompt: [
        "Rewrite this Copilot post in EL5 language. Keep the facts; teach the jargon.",
        "",
        source,
      ].join("\n"),
      maxOutputTokens: EL5_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
      abortSignal: opts?.abortSignal,
    });
    const cleaned = cleanEl5Text(result.text);
    if (cleaned.length >= 24) return { text: cleaned, error: null };
    return { text: null, error: "empty el5 response" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ el5: true, error: message }));
    return { text: null, error: message };
  }
}

export type El5ComputeDeps = {
  store: El5Store;
  createModel: () => LanguageModel | null;
  modelName?: string | null;
  now?: () => number;
};

export type El5Lookup = {
  shareId: string;
  source: string;
  sourceHash: string;
  hit: El5Translation | null;
};

/** Load the share + cache row. Throws El5Error for 404/422. */
export async function lookupEl5(
  shareId: string,
  store: El5Store,
  opts?: { force?: boolean; now?: () => number },
): Promise<El5Lookup> {
  if (!EL5_SHARE_ID_RE.test(shareId)) throw new El5Error("not found", 404);
  const share = await store.readShare(shareId);
  if (!share) throw new El5Error("not found", 404);
  const now = opts?.now?.() ?? Date.now();
  if (share.expires_at && share.expires_at < now) throw new El5Error("not found", 404);

  const source = formatEl5Source(share.messages, share.title);
  if (!source.trim()) throw new El5Error("nothing to translate", 422);
  const sourceHash = await hashEl5Source(source);
  const cached = await store.readTranslation(shareId);
  const hit = resolveEl5Cache(shareId, cached, sourceHash, opts?.force === true);
  return { shareId, source, sourceHash, hit };
}

export async function computeEl5FromLookup(
  looked: El5Lookup,
  deps: El5ComputeDeps,
): Promise<El5Translation> {
  const now = deps.now?.() ?? Date.now();
  let el5: string | null = null;
  let modelName: string | null = deps.modelName?.trim() || null;

  const model = deps.createModel();
  if (model) {
    const generated = await generateEl5Text(looked.source, model);
    if (generated.text) {
      el5 = generated.text;
    } else {
      console.warn(JSON.stringify({
        el5: true,
        fallback: "rules-v1",
        reason: generated.error ?? "empty",
      }));
    }
  }

  // OpenRouter is flaky on some envs — never hard-fail the button.
  if (!el5) {
    el5 = synthesizeEl5(looked.source);
    modelName = "rules-v1";
  }

  const row: El5CachedRow = {
    source_hash: looked.sourceHash,
    el5_text: el5,
    computed_at: now,
    model: modelName,
  };
  try {
    await deps.store.writeTranslation(looked.shareId, row);
  } catch (error) {
    console.error("el5 cache write failed", error);
  }
  return {
    share_id: looked.shareId,
    el5,
    cache_hit: false,
    computed_at: now,
    model: row.model,
  };
}

/**
 * Read cache or generate. Throws El5Error for 404/422/503.
 * HTTP handler rate-limits cache misses via lookupEl5 + computeEl5FromLookup.
 */
export async function getOrComputeEl5(
  shareId: string,
  deps: El5ComputeDeps,
  opts?: { force?: boolean },
): Promise<El5Translation> {
  const looked = await lookupEl5(shareId, deps.store, { force: opts?.force, now: deps.now });
  if (looked.hit) return looked.hit;
  return computeEl5FromLookup(looked, deps);
}

export function d1El5Store(db: D1Database): El5Store {
  return {
    async readShare(shareId) {
      const row = await db.prepare(
        `SELECT title, messages, expires_at FROM shared_chats WHERE share_id = ?1`,
      ).bind(shareId).first<{ title: string | null; messages: string; expires_at: number | null }>();
      if (!row) return null;
      let messages: unknown = null;
      try {
        messages = JSON.parse(row.messages);
      } catch {
        messages = null;
      }
      return { title: row.title, messages, expires_at: row.expires_at };
    },
    async readTranslation(shareId) {
      const row = await db.prepare(
        `SELECT source_hash, el5_text, computed_at, model FROM el5_translations WHERE share_id = ?1`,
      ).bind(shareId).first<El5CachedRow>();
      return row ?? null;
    },
    async writeTranslation(shareId, row) {
      await db.prepare(
        `INSERT INTO el5_translations (share_id, source_hash, el5_text, model, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(share_id) DO UPDATE SET
           source_hash = excluded.source_hash,
           el5_text = excluded.el5_text,
           model = excluded.model,
           computed_at = excluded.computed_at`,
      ).bind(shareId, row.source_hash, row.el5_text, row.model, row.computed_at).run();
    },
  };
}

export async function el5GenerationRateLimited(
  db: D1Database,
  ip: string,
  now = Date.now(),
): Promise<boolean> {
  if (!ip) return false;
  const recent = await db.prepare(
    `SELECT COUNT(*) AS n FROM el5_generation_log WHERE ip = ?1 AND computed_at > ?2`,
  ).bind(ip, now - EL5_RATE_WINDOW_MS).first<{ n: number }>();
  return (recent?.n ?? 0) >= EL5_RATE_LIMIT;
}

export async function logEl5Generation(
  db: D1Database,
  ip: string,
  now = Date.now(),
): Promise<void> {
  if (!ip) return;
  try {
    await db.prepare(
      `INSERT INTO el5_generation_log (ip, computed_at) VALUES (?1, ?2)`,
    ).bind(ip, now).run();
    await db.prepare(
      `DELETE FROM el5_generation_log WHERE computed_at < ?1`,
    ).bind(now - EL5_RATE_WINDOW_MS * 2).run();
  } catch (error) {
    console.warn("el5 generation log failed", error);
  }
}
