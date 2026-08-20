/**
 * Admin explore payload for Copilot system prompts + tool capabilities.
 *
 * Assembled from the same modules the runtime uses — not a stale frontend mirror.
 */
import { z } from "zod";
import { BOT_PROMPT_INVENT_SYSTEM } from "./bot-prompt";
import { botSystemAddon } from "./bots";
import { CHAT_META_SYSTEM } from "./chat-meta";
import {
  COPILOT_TOOL_DESCRIPTIONS,
  COPILOT_TOOL_INPUT_SCHEMAS,
  COPILOT_TOOL_LABELS,
  type CopilotToolName,
} from "./copilot-contract";
import { AGENT_ITERATIONS_MAX, QUERY_FORCE_FAILURES_MAX } from "./copilot-loop";
import { SCOPE_CLASSIFIER_SYSTEM } from "./copilot-scope";
import type { LakeTable } from "./copilot-sql";
import {
  SCHEMA_PLACEHOLDER,
  schemaToPrompt,
  systemPrompt,
  type BotPromptProfile,
} from "./copilot-prompt";
import { COMMENTARY_SYSTEM } from "./research-commentary";

export type CopilotPromptKind = "system" | "classifier" | "meta" | "invent" | "addon";

export interface CopilotPromptCapability {
  id: string;
  kind: CopilotPromptKind;
  title: string;
  summary: string;
  body: string;
  used_by: string;
}

export interface CopilotToolCapability {
  name: CopilotToolName;
  label: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CopilotCapabilities {
  prompts: CopilotPromptCapability[];
  tools: CopilotToolCapability[];
  meta: {
    agent_iterations_max: number;
    query_force_failures_max: number;
    schema_mode: "live" | "placeholder";
    table_count: number;
    schema_include_samples: boolean;
  };
}

const TOOL_ORDER = Object.keys(COPILOT_TOOL_INPUT_SCHEMAS) as CopilotToolName[];

function toolInputSchema(name: CopilotToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(COPILOT_TOOL_INPUT_SCHEMAS[name]);
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
 * When `tables` is provided, the main Copilot prompt embeds the live lake
 * schema (optionally without sample rows). Otherwise a placeholder marks where
 * schema text is injected at chat time.
 */
export function describeCopilotCapabilities(opts?: {
  tables?: LakeTable[];
  includeSamples?: boolean;
  bot?: BotPromptProfile | null;
}): CopilotCapabilities {
  const includeSamples = opts?.includeSamples === true;
  const tables = opts?.tables ?? [];
  const schemaMode = tables.length > 0 ? "live" : "placeholder";
  const schemaText = schemaMode === "live"
    ? schemaToPrompt(tables, { includeSamples })
    : SCHEMA_PLACEHOLDER;

  const prompts: CopilotPromptCapability[] = [
    {
      id: "copilot",
      kind: "system",
      title: "Copilot chat",
      summary: "Main agent system prompt on every Copilot turn (plus optional bot persona addon).",
      body: systemPrompt(schemaText, opts?.bot ?? null),
      used_by: "CopilotAgentBase.onChatMessage → streamText/generate ({ system })",
    },
    {
      id: "bot-addon",
      kind: "addon",
      title: "Bot persona addon",
      summary: "Appended to the Copilot system prompt when a bot profile runs (generate / schedule).",
      body: exampleBotAddon(),
      used_by: "systemPrompt(..., bot) / botSystemAddon()",
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
  ];

  const tools: CopilotToolCapability[] = TOOL_ORDER.map((name) => ({
    name,
    label: COPILOT_TOOL_LABELS[name],
    description: COPILOT_TOOL_DESCRIPTIONS[name],
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
