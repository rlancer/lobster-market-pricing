/**
 * Admin-only OpenRouter probe for notebook experiments.
 * Accepts text context, a PNG data-URL image, or both (multimodal) and
 * returns one answer.
 */

import { generateText, type LanguageModel } from "ai";
import { createCopilotModel, type CopilotModelEnv } from "./copilot-contract";

export const DEFAULT_NOTEBOOK_MODEL = "openai/gpt-4o-mini";
export const MAX_TEXT_CONTEXT_CHARS = 200_000;
export const MAX_IMAGE_DATA_URL_CHARS = 2_500_000;

export type NotebookProbeMode = "text" | "image" | "multimodal";

export interface NotebookProbeInput {
  model?: string;
  question: string;
  system?: string;
  mode: NotebookProbeMode;
  text_context?: string;
  /** `data:image/png;base64,...` (or jpeg/webp). */
  image_data_url?: string;
}

export interface NotebookProbeSuccess {
  ok: true;
  model: string;
  answer: string;
  latency_ms: number;
}

export interface NotebookProbeFailure {
  ok: false;
  error: string;
  status: number;
}

export type NotebookProbeParseResult =
  | ({ ok: true } & NotebookProbeInput)
  | NotebookProbeFailure;

const DEFAULT_SYSTEM = [
  "You are grading a market-data reading test.",
  "Use ONLY the provided context (text table/summary or chart image).",
  "Do not use outside knowledge of real tickers or prices — these series are synthetic.",
  "Follow the answer format in the question exactly. Be concise.",
].join(" ");

function parseTextContext(rec: Record<string, unknown>): string | NotebookProbeFailure {
  const text = typeof rec.text_context === "string" ? rec.text_context : "";
  if (!text.trim()) {
    return { ok: false, error: "text_context is required for this mode", status: 400 };
  }
  if (text.length > MAX_TEXT_CONTEXT_CHARS) {
    return { ok: false, error: "text_context too large", status: 400 };
  }
  return text;
}

function parseImageDataUrl(rec: Record<string, unknown>): string | NotebookProbeFailure {
  const image = typeof rec.image_data_url === "string" ? rec.image_data_url : "";
  if (!image.startsWith("data:image/")) {
    return { ok: false, error: "image_data_url must be a data:image/... URL", status: 400 };
  }
  if (image.length > MAX_IMAGE_DATA_URL_CHARS) {
    return { ok: false, error: "image_data_url too large", status: 400 };
  }
  return image;
}

export function parseNotebookProbeBody(body: unknown): NotebookProbeParseResult {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "JSON body required", status: 400 };
  }
  const rec = body as Record<string, unknown>;
  const question = typeof rec.question === "string" ? rec.question.trim() : "";
  if (!question) return { ok: false, error: "question is required", status: 400 };
  if (question.length > 4_000) return { ok: false, error: "question too long", status: 400 };

  const mode = rec.mode === "image" || rec.mode === "text" || rec.mode === "multimodal"
    ? rec.mode
    : null;
  if (!mode) {
    return { ok: false, error: "mode must be 'text', 'image', or 'multimodal'", status: 400 };
  }

  const model = typeof rec.model === "string" && rec.model.trim()
    ? rec.model.trim().slice(0, 120)
    : undefined;
  const system = typeof rec.system === "string" && rec.system.trim()
    ? rec.system.trim().slice(0, 8_000)
    : undefined;

  if (mode === "text") {
    const text = parseTextContext(rec);
    if (typeof text !== "string") return text;
    return { ok: true, model, question, system, mode, text_context: text };
  }

  if (mode === "image") {
    const image = parseImageDataUrl(rec);
    if (typeof image !== "string") return image;
    return { ok: true, model, question, system, mode, image_data_url: image };
  }

  const text = parseTextContext(rec);
  if (typeof text !== "string") return text;
  const image = parseImageDataUrl(rec);
  if (typeof image !== "string") return image;
  return {
    ok: true,
    model,
    question,
    system,
    mode,
    text_context: text,
    image_data_url: image,
  };
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) return null;
  return { mediaType: match[1]!, base64: match[2]!.replace(/\s+/g, "") };
}

export async function runNotebookProbe(
  env: CopilotModelEnv,
  origin: string,
  input: NotebookProbeInput,
): Promise<NotebookProbeSuccess | NotebookProbeFailure> {
  if (!env.OPEN_ROUTER_KEY?.trim()) {
    return { ok: false, error: "OPEN_ROUTER_KEY is not configured", status: 503 };
  }

  const modelId = input.model?.trim() || DEFAULT_NOTEBOOK_MODEL;
  const model = createCopilotModel(
    { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY, COPILOT_MODEL: modelId },
    origin,
  ) as LanguageModel;

  const system = input.system?.trim() || DEFAULT_SYSTEM;
  const started = Date.now();

  try {
    let result: { text: string };
    if (input.mode === "text") {
      result = await generateText({
        model,
        system,
        prompt: [
          "CONTEXT:",
          input.text_context,
          "",
          "QUESTION:",
          input.question,
        ].join("\n"),
        maxOutputTokens: 400,
        temperature: 0,
      });
    } else if (input.mode === "image") {
      const parsed = parseDataUrl(input.image_data_url ?? "");
      if (!parsed) {
        return { ok: false, error: "invalid image_data_url encoding", status: 400 };
      }
      result = await generateText({
        model,
        system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `QUESTION:\n${input.question}` },
              {
                type: "image",
                image: parsed.base64,
                mediaType: parsed.mediaType,
              },
            ],
          },
        ],
        maxOutputTokens: 400,
        temperature: 0,
      });
    } else {
      const parsed = parseDataUrl(input.image_data_url ?? "");
      if (!parsed) {
        return { ok: false, error: "invalid image_data_url encoding", status: 400 };
      }
      result = await generateText({
        model,
        system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "CONTEXT (markdown legend / keys — the chart image has no text labels):",
                  input.text_context,
                  "",
                  "QUESTION:",
                  input.question,
                ].join("\n"),
              },
              {
                type: "image",
                image: parsed.base64,
                mediaType: parsed.mediaType,
              },
            ],
          },
        ],
        maxOutputTokens: 400,
        temperature: 0,
      });
    }

    const answer = result.text.trim();
    if (!answer) return { ok: false, error: "model returned an empty answer", status: 502 };
    return {
      ok: true,
      model: modelId,
      answer,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `probe failed: ${message}`, status: 502 };
  }
}
