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
  suggest_trades: "Suggested trades",
  get_paper_portfolio: "Paper portfolio",
  get_schwab_portfolio: "Schwab portfolio",
  get_schwab_quotes: "Schwab quotes",
  get_bot_trades: "Bot trade performance",
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
    "Publish takes for the active desk specialists (subset of fundamental, technical, options, risk, macro) plus a weighed overview that shares the same tool evidence. " +
    "Fill only the specialists named as active for this turn; omit the rest. " +
    "Call after research_ticker / SQL / news for ticker analysis and trade ideas. " +
    "The UI shows each published viewpoint in its own panel; the final prose should be the overview, not a paste of every field.",
  suggest_trades:
    "Publish 0–3 structured trade suggestions (ticker, bias, conviction, structure, optional legs, rationale, liquidity). " +
    "Call after publish_desk on ticker/trade analysis so the UI can show trades without parsing prose. " +
    "Use trades: [] with skip_reason when nothing is tradable. Absolute strikes must come from option_contracts evidence. " +
    "Markable suggestions are auto-opened into the signed-in user's paper portfolio for PnL tracking. " +
    "When this chat is a public bot (e.g. yololobster), the same suggestions are also snapshotted into that bot's public trade book.",
  get_paper_portfolio:
    "Read this chat owner's paper portfolio: cash, equity, open/realized PnL, and positions (from auto-tracked suggest_trades). " +
    "Call when the user asks about their book, paper PnL, tracked suggestions, or how suggested trades are doing. " +
    "Optional conviction filter (high|medium|low) scopes positions and PnL. " +
    "Requires a signed-in chat owner — returns a clear error when anonymous/bot.",
  get_schwab_portfolio:
    "Read this chat owner's linked Charles Schwab brokerage book: cash, equity, day/open PnL, and positions. " +
    "Call when the user asks about their real brokerage account, Schwab balances, or live holdings. " +
    "Optional account id scopes the book to one linked account (from /api/schwab/portfolio). " +
    "Requires a signed-in owner who has connected Schwab — returns a clear error when disconnected.",
  get_schwab_quotes:
    "Fetch live Charles Schwab market-data quotes (last, bid, ask, mark, change, volume) for 1–20 symbols " +
    "using THIS chat owner's connected Schwab token only. Pass symbols only — never a user id or token. " +
    "Call when a signed-in owner asks for a live print, bid/ask, or mark. " +
    "Requires a signed-in owner who has connected Schwab — returns a clear error when disconnected or when " +
    "the session does not match the chat owner. Do not invent prints.",
  get_bot_trades:
    "Read a public bot's suggested-trade performance book (open/realized PnL and positions from auto-tracked suggest_trades). " +
    "Call when the user asks how @yololobster / @nowlobster / another bot's ideas are doing. " +
    "Pass the bot handle without @. Optional conviction filter (high|medium|low) scopes performance. " +
    "Separate from the signed-in paper portfolio.",
} as const;

const deskViewpointText = z.string().trim().min(40).max(2_400);

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
    fundamental: deskViewpointText.optional().describe(
      "Fundamental analyst take when that specialist is active for this turn.",
    ),
    technical: deskViewpointText.optional().describe(
      "Technical analyst take when that specialist is active for this turn.",
    ),
    options: deskViewpointText.optional().describe(
      "Options trader take (liquidity, IV, structure) when that specialist is active.",
    ),
    risk: deskViewpointText.optional().describe(
      "Risk analyst take (downside, sizing, what breaks) when that specialist is active.",
    ),
    macro: deskViewpointText.optional().describe(
      "Macro analyst take (rates, Fed, factor regime) when that specialist is active.",
    ),
    overview: z.string().trim().min(40).max(3_200).describe(
      "Weighed desk overview that reconciles the active specialists only.",
    ),
  }).strict(),
  suggest_trades: z.object({
    trades: z.array(z.object({
      ticker: z.string().trim().min(1).max(16).describe("Underlying ticker, e.g. AAPL or SPY."),
      bias: z.enum(["bullish", "bearish", "neutral"]),
      conviction: z.enum(["high", "medium", "low"]),
      structure: z.string().trim().min(1).max(160)
        .describe("Short structure label, e.g. bull call debit spread, long shares, covered call."),
      legs: z.array(z.object({
        instrument: z.enum(["option", "equity", "kalshi"]).optional()
          .describe("option = listed call/put; equity = stock/ETF; kalshi = event contract from options.kalshi_markets."),
        side: z.enum(["buy", "sell"]).describe("buy = long, sell = short / write."),
        qty: z.number().int().positive().max(1_000_000).optional()
          .describe("Contracts (option/kalshi) or shares (equity). Prefer when the idea is sized."),
        symbol: z.string().trim().min(1).max(16).optional()
          .describe("Leg symbol override when different from trade ticker (rare)."),
        // Option-only fields (required by normalize when instrument=option).
        right: z.enum(["call", "put"]).optional().describe("Required for option legs."),
        strike: z.number().positive().optional().describe("Absolute strike from option_contracts when known."),
        strike_rel: z.string().trim().min(1).max(40).optional()
          .describe("Relative strike when absolute unknown, e.g. ATM or ~5% OTM."),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD expiration."),
        dte: z.number().int().min(0).max(730).optional(),
        // Kalshi-only fields.
        market_ticker: z.string().trim().min(1).max(64).optional()
          .describe("Kalshi market ticker from options.kalshi_markets (required for kalshi legs)."),
        contract_side: z.enum(["yes", "no"]).optional()
          .describe("Kalshi YES or NO side; defaults to yes."),
      }).strict()).max(4).optional(),
      rationale: z.string().trim().min(1).max(480).describe("Why this structure fits the shared evidence."),
      liquidity: z.string().trim().min(1).max(240).optional().describe("Quote quality from lake (spread, volume/OI)."),
    }).strict()).max(3),
    skip_reason: z.string().trim().min(1).max(320).optional()
      .describe("Optional when trades is empty — why no tradable lean. Defaults if omitted."),
  }).strict(),
  get_paper_portfolio: z.object({
    status: z.enum(["open", "closed", "all"]).default("open")
      .describe("Which positions to include. Default open."),
    conviction: z.enum(["high", "medium", "low"]).optional()
      .describe("Optional conviction filter for positions and PnL."),
  }).strict(),
  get_schwab_portfolio: z.object({
    account: z.string().trim().min(1).max(80).optional()
      .describe("Optional linked Schwab account id to scope balances and positions."),
  }).strict(),
  get_schwab_quotes: z.object({
    symbols: z.array(z.string().trim().min(1).max(32)).min(1).max(20)
      .describe("Tickers to quote (equities, $SPX, /ES, OCC options). Symbols only — never a user id."),
  }).strict(),
  get_bot_trades: z.object({
    handle: z.string().trim().min(1).max(32)
      .describe("Bot handle without @, e.g. yololobster or nowlobster."),
    status: z.enum(["open", "closed", "all"]).default("open")
      .describe("Which positions to include. Default open."),
    conviction: z.enum(["high", "medium", "low"]).optional()
      .describe("Optional conviction filter for positions and PnL."),
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
