/**
 * Admin explore payload for Chat system prompts + tool capabilities.
 *
 * Assembled from the same modules the runtime uses — not a stale frontend mirror.
 */
import { z } from "zod";
import { BOT_PROMPT_INVENT_SYSTEM } from "./bot-prompt";
import { botSystemAddon } from "./bots";
import { CHAT_META_SYSTEM } from "./chat-meta";
import {
  CHAT_TOOL_DESCRIPTIONS,
  CHAT_TOOL_INPUT_SCHEMAS,
  CHAT_TOOL_LABELS,
  type ChatToolName,
} from "./chat-contract";
import { AGENT_ITERATIONS_MAX, QUERY_FORCE_FAILURES_MAX } from "./chat-loop";
import { SCOPE_CLASSIFIER_SYSTEM } from "./chat-scope";
import type { LakeTable } from "./chat-sql";
import {
  SCHEMA_PLACEHOLDER,
  schemaToPrompt,
  systemPrompt,
  type BotPromptProfile,
} from "./chat-prompt";
import {
  DESK_OVERVIEW_SUMMARY,
  DESK_SPECIALIST_SUMMARIES,
  deskAnalystBlock,
} from "./chat-desk";
import { tradesSuggestBlock } from "./chat-trades";
import { COMMENTARY_SYSTEM } from "./research-commentary";
import { EL5_SYSTEM } from "./el5";
import { DEFAULT_REPLY_STYLE, replyStyleAddon } from "./reply-style";
import { attachmentsPromptAddon } from "./chat-attachments";

export type ChatPromptKind = "system" | "classifier" | "meta" | "invent" | "addon";

export interface ChatPromptCapability {
  id: string;
  kind: ChatPromptKind;
  title: string;
  summary: string;
  body: string;
  used_by: string;
}

export interface ChatToolCapability {
  name: ChatToolName;
  label: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatCapabilities {
  prompts: ChatPromptCapability[];
  tools: ChatToolCapability[];
  meta: {
    agent_iterations_max: number;
    query_force_failures_max: number;
    schema_mode: "live" | "placeholder";
    table_count: number;
    schema_include_samples: boolean;
  };
}

const TOOL_ORDER = Object.keys(CHAT_TOOL_INPUT_SCHEMAS) as ChatToolName[];

function toolInputSchema(name: ChatToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(CHAT_TOOL_INPUT_SCHEMAS[name]);
  // Drop the draft meta — UI only needs the shape the model sees.
  const { $schema: _schema, ...rest } = schema as Record<string, unknown>;
  return rest;
}

function exampleBotAddon(): string {
  return botSystemAddon({
    handle: "examplebot",
    display_name: "Example Bot",
    persona: "<persona from bot_profiles.persona>",
    system_prompt_extra: "<optional system_prompt_extra>",
  });
}

/**
 * Build the admin capabilities catalog.
 *
 * When `tables` is provided, the main Chat prompt embeds the live lake
 * schema (optionally without sample rows). Otherwise a placeholder marks where
 * schema text is injected at chat time.
 */
export function describeChatCapabilities(opts?: {
  tables?: LakeTable[];
  includeSamples?: boolean;
  bot?: BotPromptProfile | null;
}): ChatCapabilities {
  const includeSamples = opts?.includeSamples === true;
  const tables = opts?.tables ?? [];
  const schemaMode = tables.length > 0 ? "live" : "placeholder";
  const schemaText = schemaMode === "live"
    ? schemaToPrompt(tables, { includeSamples })
    : SCHEMA_PLACEHOLDER;

  const prompts: ChatPromptCapability[] = [
    {
      id: "chat",
      kind: "system",
      title: "Chat",
      summary: "Main desk system prompt on every Chat turn (routed specialists + overview, plus optional bot persona addon).",
      body: systemPrompt(schemaText, opts?.bot ?? null),
      used_by: "CopilotAgentBase.onChatMessage → streamText/generate ({ system })",
    },
    {
      id: "desk-analysts",
      kind: "system",
      title: "Multi-analyst desk",
      summary: "Core specialists (fundamental, technical, options, risk) plus macro when routed; all share lake evidence; overview weighs the active set. Enforced via publish_desk.",
      body: [
        deskAnalystBlock(),
        "",
        "Specialist focus (reference):",
        `- Fundamental: ${DESK_SPECIALIST_SUMMARIES.fundamental}`,
        `- Technical: ${DESK_SPECIALIST_SUMMARIES.technical}`,
        `- Options: ${DESK_SPECIALIST_SUMMARIES.options}`,
        `- Risk: ${DESK_SPECIALIST_SUMMARIES.risk}`,
        `- Macro: ${DESK_SPECIALIST_SUMMARIES.macro}`,
        `- Overview: ${DESK_OVERVIEW_SUMMARY}`,
      ].join("\n"),
      used_by: "systemPrompt() desk block + publish_desk tool + selectDeskSpecialists()",
    },
    {
      id: "suggest-trades",
      kind: "system",
      title: "Suggested trades",
      summary: "Structured trade suggestions (bias, conviction, legs) via suggest_trades — UI does not parse prose.",
      body: tradesSuggestBlock(),
      used_by: "systemPrompt() trades block + suggest_trades tool",
    },
    {
      id: "bot-addon",
      kind: "addon",
      title: "Bot persona addon",
      summary: "Appended to the chat system prompt when a bot profile runs (generate / schedule).",
      body: exampleBotAddon(),
      used_by: "systemPrompt(..., bot) / botSystemAddon()",
    },
    {
      id: "reply-style",
      kind: "addon",
      title: "User reply voice",
      summary: "Canned audience (desk / hedge fund / new to trading) plus an optional 240-char note. Same Chat tools as bots; voice only.",
      body: replyStyleAddon({ style: DEFAULT_REPLY_STYLE, note: "<optional reply_note, max 240 chars>" }),
      used_by: "systemPrompt(..., { reply }) / parseReplyPrefFromBody()",
    },
    {
      id: "chat-attachments",
      kind: "addon",
      title: "Attached portfolios",
      summary: "User-opted portfolio handles from chat controls. Instructs get_portfolio for Schwab/paper; extend sources as new brokers land.",
      body: attachmentsPromptAddon([
        { kind: "portfolio", source: "schwab" },
        { kind: "portfolio", source: "paper" },
      ]),
      used_by: "systemPrompt(..., { attachments }) / parseAttachmentsFromBody()",
    },
    {
      id: "scope-classifier",
      kind: "classifier",
      title: "Finance scope classifier",
      summary: "Pre-turn IN_SCOPE / OUT_OF_SCOPE gate before tools run.",
      body: SCOPE_CLASSIFIER_SYSTEM,
      used_by: "classifyFinanceScope()",
    },
    {
      id: "chat-meta",
      kind: "meta",
      title: "Chat title + ticker NER",
      summary: "Flash model that proposes a display title and public ticker tags after a turn or share mint.",
      body: CHAT_META_SYSTEM,
      used_by: "deriveChatMeta()",
    },
    {
      id: "bot-prompt-invent",
      kind: "invent",
      title: "Bot prompt invent",
      summary: "Mints a fresh unique user question when a bot has no unused seed left.",
      body: BOT_PROMPT_INVENT_SYSTEM,
      used_by: "inventBotPrompt()",
    },
    {
      id: "research-commentary",
      kind: "system",
      title: "Research ticker commentary",
      summary: "Brand-voice takeaway on /research/{ticker} grounded in the cached brief.",
      body: COMMENTARY_SYSTEM,
      used_by: "generateTickerCommentary()",
    },
    {
      id: "el5-post",
      kind: "system",
      title: "EL5 post translation",
      summary: "Quick Markdown summary of a public shared chat post for adults with basic market knowledge. Cached in D1 per share_id + source hash.",
      body: EL5_SYSTEM,
      used_by: "generateEl5Text() / GET /api/share/{id}/el5",
    },
  ];

  const tools: ChatToolCapability[] = TOOL_ORDER.map((name) => ({
    name,
    label: CHAT_TOOL_LABELS[name],
    description: CHAT_TOOL_DESCRIPTIONS[name],
    input_schema: toolInputSchema(name),
  }));

  return {
    prompts,
    tools,
    meta: {
      agent_iterations_max: AGENT_ITERATIONS_MAX,
      query_force_failures_max: QUERY_FORCE_FAILURES_MAX,
      schema_mode: schemaMode,
      table_count: tables.length,
      schema_include_samples: includeSamples,
    },
  };
}
