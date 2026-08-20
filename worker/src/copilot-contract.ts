import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

export const FRAME_QUERY_LIMIT = 5_000;
export const LAST_FRAME_NAME = "last";

const frameAggregation = z.object({
  fn: z.enum(["avg", "sum", "count", "min", "max"]),
  column: z.string().min(1).optional(),
  as: z.string().trim().min(1).max(80).optional(),
}).strict();

/** Human labels shown in the Copilot UI / tool-call chips. */
export const COPILOT_TOOL_LABELS = {
  run_query: "SQL query",
  check_schema: "Check schema",
  list_frames: "List frames",
  filter_frame: "Filter frame",
  refresh_frame: "Refresh frame",
  render_chart: "Render chart",
  get_news: "News",
  eco_calendar: "Eco calendar",
  web_search: "Web search",
  research_ticker: "Ticker research",
  publish_desk: "Desk viewpoints",
} as const;

/** Model-facing tool descriptions — single source for createTools + admin explore. */
export const COPILOT_TOOL_DESCRIPTIONS = {
  run_query:
    "Execute one read-only DataFusion SQL SELECT/WITH query against the options Iceberg lake. SQL is validated against the real schema first. Every successful result is cached as frame 'last' (up to 5000 rows) for local filter/reduce follow-ups. Pass save_as for a named alias.",
  check_schema: "Validate proposed SQL against the real options table and column names without executing it.",
  list_frames: "List this chat's cached result frames, including columns, row counts, age, and value sketches.",
  filter_frame:
    "Filter, sort, project, limit, or reduce a cached frame without querying the lake. where and sort use expressions over column names with ==, !=, <, <=, >, >=, &&, ||, !, abs, min, max, and round. aggregations (avg/sum/count/min/max) with optional group_by compile to the same parameterized SQLite path. Use frame 'last' for the most recent run_query result.",
  refresh_frame: "Re-run a cached frame's source query after it becomes stale.",
  render_chart:
    "Validate a chart specification for the most recent query result (or a named frame). Call after run_query or filter_frame when the user requested a chart. The UI only draws a chart from this tool.",
  get_news: "Fetch recent headlines for one ticker when explaining why a stock, option volume, or implied volatility moved.",
  web_search: "Search for current market commentary or events and return up to five citable links.",
  eco_calendar: "Fetch scheduled macro events for the next 7 to 90 days.",
  research_ticker:
    "Link a ticker to this chat and return a cached research brief " +
    "(recent price/volume moves, consolidation/accumulation, lake fundamentals, earnings, news). " +
    "Accepts equities/ETFs, indexes (^VIX), continuous futures (ES=F, BTC=F), and spot crypto (BTC-USD). " +
    "For Bitcoin spot use BTC-USD — not IBIT unless the user asked for the ETF. " +
    "Call whenever you suggest a trade or deep-dive a specific underlying.",
  publish_desk:
    "Publish the three specialist takes (fundamental, technical, options) plus a weighed desk overview that shares the same tool evidence. " +
    "Call after research_ticker / SQL / news for ticker analysis and trade ideas. " +
    "The UI shows each viewpoint in its own panel; the final prose should be the overview, not a paste of all four fields.",
} as const;

const deskViewpointText = z.string().trim().min(1).max(2_400);

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
    group_by: z.array(z.string().min(1)).max(16).optional(),
    aggregations: z.array(frameAggregation).max(32).optional(),
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
  research_ticker: z.object({
    symbol: z.string().trim().min(1).max(16),
    force: z.boolean().optional(),
  }).strict(),
  publish_desk: z.object({
    fundamental: deskViewpointText.describe("Fundamental analyst take grounded in shared lake evidence."),
    technical: deskViewpointText.describe("Technical analyst take grounded in the same evidence."),
    options: deskViewpointText.describe("Options trader take (liquidity, IV, structure) grounded in the same evidence."),
    overview: z.string().trim().min(1).max(3_200).describe("Weighed desk overview that reconciles the three specialists."),
  }).strict(),
} as const;

export type CopilotToolName = keyof typeof COPILOT_TOOL_INPUT_SCHEMAS;

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
