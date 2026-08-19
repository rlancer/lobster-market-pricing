/**
 * Unique starter prompts for bot generate runs.
 *
 * Generate must mint a chat whose user prompt is not a repeat of a prior run
 * for that bot — unused seed prompts first, then an LLM invent that is
 * meaningfully different from what was already used.
 */
import { generateText, type LanguageModel } from "ai";
import type { BotProfile } from "./bots";

export const BOT_PROMPT_INVENT_SYSTEM = [
  "You write one fresh user question for Lobster MP, a US equities & ETF options market-data Copilot.",
  "Output ONLY the question text — no quotes, labels, markdown, or preamble.",
  "Keep it to 1–3 sentences. It must be answerable with options/market data tools (volume, OI, IV, greeks, earnings, catalysts).",
  "Match the bot persona's voice and risk appetite.",
  "The question must be clearly different from every prior prompt listed — not a paraphrase, synonym swap, or mild rewording.",
  "Vary ticker universe, structure (calls vs puts, spreads, lotteries), horizon, and angle so a human would say it is a new chat topic.",
].join("\n");

/** Collapse whitespace + case for duplicate detection. */
export function normalizeBotPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isBotPromptUsed(prompt: string, usedPrompts: string[]): boolean {
  const key = normalizeBotPrompt(prompt);
  if (!key) return false;
  return usedPrompts.some((used) => normalizeBotPrompt(used) === key);
}

/** First seed that has not appeared (normalized) in prior runs. */
export function pickUnusedSeedPrompt(seeds: string[], usedPrompts: string[]): string | null {
  for (const seed of seeds) {
    const trimmed = seed.trim();
    if (trimmed && !isBotPromptUsed(trimmed, usedPrompts)) return trimmed;
  }
  return null;
}

/**
 * Resolve the prompt for a generate run.
 * - Explicit unused client prompt wins.
 * - Else first unused seed.
 * - Else null → caller should invent via LLM.
 */
export function resolveBotGeneratePrompt(
  requested: string | undefined,
  seeds: string[],
  usedPrompts: string[],
): { prompt: string; source: "requested" | "seed" } | { prompt: null; source: "invent" } {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (trimmed && !isBotPromptUsed(trimmed, usedPrompts)) {
    return { prompt: trimmed, source: "requested" };
  }
  const unused = pickUnusedSeedPrompt(seeds, usedPrompts);
  if (unused) return { prompt: unused, source: "seed" };
  return { prompt: null, source: "invent" };
}

export type InventBotPromptProfile = Pick<
  BotProfile,
  "handle" | "display_name" | "persona" | "system_prompt_extra" | "seed_prompts"
>;

function inventUserPrompt(bot: InventBotPromptProfile, usedPrompts: string[]): string {
  const usedBlock =
    usedPrompts.length === 0
      ? "(none yet)"
      : usedPrompts
          .slice(0, 40)
          .map((p, i) => `${i + 1}. ${p.trim().slice(0, 400)}`)
          .join("\n");
  const seedHint =
    bot.seed_prompts.length > 0
      ? `Seed examples (style only — do not copy):\n${bot.seed_prompts
          .slice(0, 8)
          .map((s) => `- ${s.trim().slice(0, 300)}`)
          .join("\n")}`
      : "No seed examples — invent from the persona.";
  return [
    `Bot: @${bot.handle} (${bot.display_name})`,
    `Persona: ${bot.persona}`,
    bot.system_prompt_extra.trim()
      ? `Persona guidance:\n${bot.system_prompt_extra.trim().slice(0, 2_000)}`
      : null,
    seedHint,
    "Prior prompts already used in chats (do not repeat or lightly rephrase):",
    usedBlock,
    "Write one new user question now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function cleanInventedPrompt(text: string): string {
  return text
    .replace(/^```(?:text|markdown|md)?\s*/i, "")
    .replace(/```$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/^(prompt|question)\s*:\s*/i, "")
    .trim();
}

/**
 * Ask the model for a market question that is not the same as prior runs.
 * Retries once if the first draft collides with a used prompt.
 */
export async function inventBotPrompt(
  bot: InventBotPromptProfile,
  usedPrompts: string[],
  model: LanguageModel,
  opts?: { abortSignal?: AbortSignal },
): Promise<string | null> {
  const attempt = async (): Promise<string | null> => {
    try {
      const result = await generateText({
        model,
        system: BOT_PROMPT_INVENT_SYSTEM,
        prompt: inventUserPrompt(bot, usedPrompts),
        maxOutputTokens: 220,
        temperature: 0.95,
        abortSignal: opts?.abortSignal,
      });
      const cleaned = cleanInventedPrompt(result.text);
      if (!cleaned || cleaned.length < 12) return null;
      if (isBotPromptUsed(cleaned, usedPrompts)) return null;
      return cleaned.slice(0, 4_000);
    } catch (error) {
      console.warn(JSON.stringify({
        botPromptInvent: true,
        handle: bot.handle,
        error: error instanceof Error ? error.message : String(error),
      }));
      return null;
    }
  };

  const first = await attempt();
  if (first) return first;
  return attempt();
}
