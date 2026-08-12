import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

export const FRAME_QUERY_LIMIT = 5_000;

export const COPILOT_TOOL_INPUT_SCHEMAS = {
  run_query: z.object({ sql: z.string().min(1), save_as: z.string().trim().min(1).max(80).optional() }).strict(),
  check_schema: z.object({ sql: z.string().min(1) }).strict(),
  list_frames: z.object({}).strict(),
  filter_frame: z.object({
    frame: z.string().trim().min(1),
    where: z.string().optional(),
    sort: z.string().optional(),
    limit: z.number().int().min(0).max(FRAME_QUERY_LIMIT).optional(),
    project: z.array(z.string()).max(100).optional(),
    save_as: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  refresh_frame: z.object({ frame: z.string().trim().min(1) }).strict(),
  render_chart: z.object({
    title: z.string().max(160).optional(),
    kind: z.enum(["line", "area", "scatter", "bar"]).default("line"),
    x: z.string().min(1),
    y: z.string().min(1),
    series: z.string().optional(),
    xLabel: z.string().max(80).optional(),
    yLabel: z.string().max(80).optional(),
  }).strict(),
  get_news: z.object({ symbol: z.string().trim().min(1), limit: z.number().int().min(1).max(20).default(8) }).strict(),
  web_search: z.object({ query: z.string().trim().min(1).max(200), max_results: z.number().int().min(1).max(5).default(5) }).strict(),
  eco_calendar: z.object({ days: z.number().int().min(7).max(90).default(30) }).strict(),
} as const;

export interface CopilotModelEnv {
  OPEN_ROUTER_KEY: string;
  COPILOT_MODEL: string;
}

export function createCopilotModel(env: CopilotModelEnv, origin: string, fetchImpl?: typeof fetch) {
  const openrouter = createOpenRouter({
    apiKey: env.OPEN_ROUTER_KEY,
    appName: "Open Interest Options Workspace",
    appUrl: origin,
    compatibility: "strict",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return openrouter(env.COPILOT_MODEL, { parallelToolCalls: false });
}
