/**
 * Signed-in account bots — private scheduled Copilot runs.
 *
 * Distinct from public admin personas in bot_profiles: no public handle,
 * no /u page, no timeline stamp unless the owner opts in.
 */
import { nextScheduleWakeMs, type MarketHoursEnv } from "./market-hours";
import { getHandle } from "./profiles";

export const USER_BOT_NAME_MAX = 80;
export const USER_BOT_PROMPT_MAX = 4_000;
export const USER_BOT_MAX_PER_USER = 10;
export const USER_BOT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const USER_BOT_RUN_TIMEOUT_ERROR = "timed out waiting for completion";
/** Run now replaces a hung in-progress row after this age so a retry is not stuck. */
export const USER_BOT_FORCE_STALE_MS = 2 * 60 * 1000;

export const USER_BOT_PRESETS = [
  {
    id: "hourly_market",
    label: "Every hour during US market hours",
    description: "Fires each hour while the US cash session is open; sleeps on nights, weekends, and holidays.",
    cadence_seconds: 3600,
    market_gated: true,
  },
  {
    id: "every_2h_market",
    label: "Every 2 hours during US market hours",
    description: "Same market-hours gate, half as often.",
    cadence_seconds: 7200,
    market_gated: true,
  },
  {
    id: "daily_open",
    label: "Once a day at US market open",
    description: "One pass after the cash open, then sleeps until the next session.",
    cadence_seconds: 86_400,
    market_gated: true,
  },
  {
    id: "hourly",
    label: "Every hour, any time",
    description: "Runs around the clock, including nights and weekends.",
    cadence_seconds: 3600,
    market_gated: false,
  },
  {
    id: "daily",
    label: "Once a day, any time",
    description: "One pass every 24 hours, market open or closed.",
    cadence_seconds: 86_400,
    market_gated: false,
  },
] as const;

export type UserBotPresetId = (typeof USER_BOT_PRESETS)[number]["id"];

export const USER_BOT_TEMPLATES = [
  {
    id: "portfolio_risk",
    label: "Portfolio risk check",
    prompt:
      "Review my attached portfolio. Flag concentration, expiration risk, delta/gamma exposure, and any adjustments I should consider before the next session. Ground every claim in the attached book plus lake quotes. Close with a short list of actions I can take now, or say the book looks fine.",
  },
  {
    id: "adjustments",
    label: "Adjustment ideas",
    prompt:
      "Look at my attached portfolio and recommend specific adjustments — rolls, hedges, or trims — with tradable structures. Read the attached book first, then research_ticker and option_contracts for any recommended legs. Skip names that do not quote.",
  },
  {
    id: "custom",
    label: "Custom",
    prompt: "",
  },
] as const;

export type UserBotTemplateId = (typeof USER_BOT_TEMPLATES)[number]["id"];

export const USER_BOT_PORTFOLIO_SOURCES = ["none", "paper", "schwab", "all"] as const;
export type UserBotPortfolioSource = (typeof USER_BOT_PORTFOLIO_SOURCES)[number];

export interface UserBotPortfolioOption {
  id: string;
  label: string;
  source: UserBotPortfolioSource;
  account_id: string | null;
}

export type UserBotRunStatus = "queued" | "running" | "completed" | "shared" | "failed";

export interface UserBot {
  bot_id: string;
  user_id: string;
  name: string;
  prompt: string;
  schedule_preset: UserBotPresetId;
  cadence_seconds: number;
  market_gated: boolean;
  attach_portfolio: boolean;
  portfolio_source: UserBotPortfolioSource;
  portfolio_account_id: string | null;
  portfolio_account_ids: string[];
  portfolio_id: string;
  portfolio_ids: string[];
  publish_to_timeline: boolean;
  email_alerts: boolean;
  enabled: boolean;
  next_run_at: number;
  last_run_at: number | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserBotRun {
  run_id: string;
  bot_id: string;
  user_id: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: UserBotRunStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserBotInput {
  name?: unknown;
  prompt?: unknown;
  template_id?: unknown;
  schedule_preset?: unknown;
  attach_portfolio?: unknown;
  portfolio_id?: unknown;
  portfolio_ids?: unknown;
  portfolio_source?: unknown;
  portfolio_account_id?: unknown;
  publish_to_timeline?: unknown;
  email_alerts?: unknown;
  enabled?: unknown;
}

type UserBotRow = {
  bot_id: string;
  user_id: string;
  name: string;
  prompt: string;
  schedule_preset: string;
  cadence_seconds: number;
  market_gated: number;
  attach_portfolio: number;
  portfolio_source?: string | null;
  portfolio_account_id?: string | null;
  portfolio_ids?: string | null;
  publish_to_timeline: number;
  email_alerts: number;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  run_id: string;
  bot_id: string;
  user_id: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function boolish(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return !(value === false || value === 0 || value === "0" || value === "false");
}

export function isUserBotPortfolioSource(value: unknown): value is UserBotPortfolioSource {
  return typeof value === "string" && (USER_BOT_PORTFOLIO_SOURCES as readonly string[]).includes(value);
}

export function portfolioOptionId(
  source: UserBotPortfolioSource,
  accountId?: string | null,
): string {
  if (source === "schwab" && accountId) return `schwab:${accountId}`;
  return source;
}

export function parsePortfolioOptionId(raw: unknown): {
  source: UserBotPortfolioSource;
  accountId: string | null;
} | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id) return null;
  if (id === "none" || id === "paper" || id === "all" || id === "schwab") {
    return { source: id, accountId: null };
  }
  if (id.startsWith("schwab:")) {
    const accountId = id.slice("schwab:".length).trim().slice(0, 80);
    if (!accountId) return null;
    return { source: "schwab", accountId };
  }
  return null;
}

export function parsePortfolioIdsJson(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return normalizePortfolioIds(raw);
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizePortfolioIds(parsed) : null;
  } catch {
    return null;
  }
}

export function normalizePortfolioIds(raw: unknown[]): string[] {
  const ids: string[] = [];
  for (const item of raw) {
    const parsed = parsePortfolioOptionId(item);
    if (!parsed || parsed.source === "none") continue;
    const id = portfolioOptionId(parsed.source, parsed.accountId);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function derivePortfolioFromIds(ids: string[]): {
  source: UserBotPortfolioSource;
  accountId: string | null;
  accountIds: string[];
  ids: string[];
} {
  const hasPaper = ids.includes("paper") || ids.includes("all");
  const hasAllSchwab = ids.includes("schwab") || ids.includes("all");
  const accountIds = [...new Set(
    ids.filter((id) => id.startsWith("schwab:")).map((id) => id.slice("schwab:".length)),
  )];
  if (!hasPaper && !hasAllSchwab && accountIds.length === 0) {
    return { source: "none", accountId: null, accountIds: [], ids: [] };
  }
  if (hasPaper && (hasAllSchwab || accountIds.length > 0)) {
    return {
      source: "all",
      accountId: !hasAllSchwab && accountIds.length === 1 ? accountIds[0] : null,
      accountIds: hasAllSchwab ? [] : accountIds,
      ids: hasAllSchwab ? ["paper", "schwab"] : ["paper", ...accountIds.map((id) => `schwab:${id}`)],
    };
  }
  if (hasPaper) return { source: "paper", accountId: null, accountIds: [], ids: ["paper"] };
  return {
    source: "schwab",
    accountId: !hasAllSchwab && accountIds.length === 1 ? accountIds[0] : null,
    accountIds: hasAllSchwab ? [] : accountIds,
    ids: hasAllSchwab ? ["schwab"] : accountIds.map((id) => `schwab:${id}`),
  };
}

export function resolveUserBotPortfolio(
  body: UserBotInput,
  existing?: UserBot | null,
): {
  source: UserBotPortfolioSource;
  accountId: string | null;
  accountIds: string[];
  ids: string[];
} {
  const fromIds = parsePortfolioIdsJson(body.portfolio_ids);
  if (fromIds) return derivePortfolioFromIds(fromIds);
  const fromId = parsePortfolioOptionId(body.portfolio_id);
  if (fromId) return derivePortfolioFromIds([portfolioOptionId(fromId.source, fromId.accountId)]);
  if (isUserBotPortfolioSource(body.portfolio_source)) {
    const accountRaw = typeof body.portfolio_account_id === "string"
      ? body.portfolio_account_id.trim().slice(0, 80)
      : "";
    if (body.portfolio_source === "none") return derivePortfolioFromIds([]);
    if (body.portfolio_source === "paper") return derivePortfolioFromIds(["paper"]);
    if (body.portfolio_source === "all") return derivePortfolioFromIds(["paper", "schwab"]);
    return derivePortfolioFromIds([portfolioOptionId("schwab", accountRaw || null)]);
  }
  if (body.attach_portfolio !== undefined && body.attach_portfolio !== null && body.attach_portfolio !== "") {
    return derivePortfolioFromIds(boolish(body.attach_portfolio, true) ? ["paper", "schwab"] : []);
  }
  if (existing) {
    return derivePortfolioFromIds(existing.portfolio_ids);
  }
  return derivePortfolioFromIds(["paper"]);
}

export function attachablePortfolioOptions(
  schwabAccounts: Array<{ id: string; label: string }>,
): UserBotPortfolioOption[] {
  const options: UserBotPortfolioOption[] = [
    { id: "none", label: "Don't attach a portfolio", source: "none", account_id: null },
    { id: "paper", label: "Paper book", source: "paper", account_id: null },
  ];
  for (const account of schwabAccounts) {
    options.push({
      id: portfolioOptionId("schwab", account.id),
      label: account.label,
      source: "schwab",
      account_id: account.id,
    });
  }
  if (schwabAccounts.length > 1) {
    options.push({ id: "schwab", label: "All Schwab accounts", source: "schwab", account_id: null });
  }
  if (schwabAccounts.length > 0) {
    options.push({ id: "all", label: "Paper book + Schwab", source: "all", account_id: null });
  }
  return options;
}

/** Checkable books for MultiSelector — paper plus each linked Schwab account. */
export function attachableBookOptions(
  schwabAccounts: Array<{ id: string; label: string }>,
): UserBotPortfolioOption[] {
  return attachablePortfolioOptions(schwabAccounts).filter((option) => (
    option.id === "paper" || Boolean(option.account_id)
  ));
}

export function listUserBotPresets(): Array<{
  id: UserBotPresetId;
  label: string;
  description: string;
  cadence_seconds: number;
  market_gated: boolean;
}> {
  return USER_BOT_PRESETS.map((preset) => ({ ...preset }));
}

export function listUserBotTemplates(): Array<{
  id: UserBotTemplateId;
  label: string;
  prompt: string;
}> {
  return USER_BOT_TEMPLATES.map((template) => ({ ...template }));
}

export function resolveUserBotPreset(id: unknown): (typeof USER_BOT_PRESETS)[number] | null {
  if (typeof id !== "string") return null;
  return USER_BOT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function resolveUserBotTemplate(id: unknown): (typeof USER_BOT_TEMPLATES)[number] | null {
  if (typeof id !== "string") return null;
  return USER_BOT_TEMPLATES.find((template) => template.id === id) ?? null;
}

export function validateUserBotInput(
  body: UserBotInput,
  existing?: UserBot | null,
):
  | {
    ok: true;
    value: {
      name: string;
      prompt: string;
      schedule_preset: UserBotPresetId;
      cadence_seconds: number;
      market_gated: boolean;
      attach_portfolio: boolean;
      portfolio_source: UserBotPortfolioSource;
      portfolio_account_id: string | null;
      portfolio_ids: string[];
      publish_to_timeline: boolean;
      email_alerts: boolean;
      enabled: boolean;
    };
  }
  | { ok: false; error: string } {
  const nameRaw = typeof body.name === "string" ? body.name.trim() : (existing?.name ?? "");
  const name = nameRaw.slice(0, USER_BOT_NAME_MAX);
  if (!name) return { ok: false, error: "name is required" };

  let prompt = existing?.prompt ?? "";
  const template = resolveUserBotTemplate(body.template_id);
  if (typeof body.prompt === "string") {
    prompt = body.prompt.trim();
  } else if (template && template.prompt) {
    prompt = template.prompt;
  }
  prompt = prompt.slice(0, USER_BOT_PROMPT_MAX);
  if (!prompt) return { ok: false, error: "tell the bot what to do" };

  const preset = body.schedule_preset !== undefined
    ? resolveUserBotPreset(body.schedule_preset)
    : (existing ? resolveUserBotPreset(existing.schedule_preset) : resolveUserBotPreset("hourly_market"));
  if (!preset) return { ok: false, error: "choose how often the bot should run" };

  const portfolio = resolveUserBotPortfolio(body, existing);

  return {
    ok: true,
    value: {
      name,
      prompt,
      schedule_preset: preset.id,
      cadence_seconds: preset.cadence_seconds,
      market_gated: preset.market_gated,
      attach_portfolio: portfolio.source !== "none",
      portfolio_source: portfolio.source,
      portfolio_account_id: portfolio.accountId,
      portfolio_ids: portfolio.ids,
      publish_to_timeline: boolish(body.publish_to_timeline, existing?.publish_to_timeline ?? false),
      email_alerts: boolish(body.email_alerts, existing?.email_alerts ?? true),
      enabled: boolish(body.enabled, existing?.enabled ?? true),
    },
  };
}

/** Private-bot system addon — never instructs a public timeline post. */
export function userBotSystemAddon(opts: {
  name: string;
  attach_portfolio?: boolean;
  portfolio_source?: UserBotPortfolioSource;
  portfolio_account_id?: string | null;
  portfolio_account_ids?: string[];
  portfolio_label?: string | null;
  publish_to_timeline: boolean;
}): string {
  const source = opts.portfolio_source
    ?? (opts.attach_portfolio === false ? "none" : opts.attach_portfolio ? "all" : "none");
  const accountIds = opts.portfolio_account_ids?.filter(Boolean)
    ?? (opts.portfolio_account_id ? [opts.portfolio_account_id] : []);
  const lines = [
    "",
    `Private account bot (${opts.name}):`,
    "You are writing a personal briefing for the signed-in owner of this chat — not a public timeline post.",
    "Stay grounded in tool results. Close with a sharp 1–3 sentence takeaway the owner can act on or dismiss.",
  ];
  if (source === "paper") {
    lines.push(
      "The owner attached their paper book. MUST call get_paper_portfolio before recommending anything. Do not call get_schwab_portfolio. Do not invent positions, fills, or balances.",
    );
  } else if (source === "schwab") {
    const label = opts.portfolio_label?.trim()
      || (accountIds.length === 1 ? "the selected Schwab account" : "the linked Schwab accounts");
    const accountClause = accountIds.length === 1
      ? ` and pass account="${accountIds[0]}"`
      : accountIds.length > 1
        ? ` scoped to accounts ${accountIds.map((id) => `"${id}"`).join(", ")}`
        : "";
    lines.push(
      `The owner attached ${label}. MUST call get_schwab_portfolio before recommending anything${accountClause}`
      + ". Do not call get_paper_portfolio. If you need a live print, call get_schwab_quotes with symbols only — the owner's connected token is used automatically. If Schwab is not connected, say so. Do not invent positions, fills, or account numbers.",
    );
  } else if (source === "all") {
    const schwabClause = accountIds.length === 1
      ? ` get_schwab_portfolio with account="${accountIds[0]}"`
      : accountIds.length > 1
        ? ` get_schwab_portfolio scoped to accounts ${accountIds.map((id) => `"${id}"`).join(", ")}`
        : " get_schwab_portfolio";
    lines.push(
      `The owner attached the paper book and Schwab. MUST call get_paper_portfolio and${schwabClause} before recommending anything. Live prints: get_schwab_quotes with symbols only (owner token). If Schwab is not connected, say so and use the paper book. Do not invent positions, fills, or balances.`,
    );
  } else {
    lines.push(
      "No portfolio is attached. Do not call get_paper_portfolio or get_schwab_portfolio unless the owner asks about a book in this prompt.",
    );
  }
  if (source !== "none") {
    lines.push(
      "Identify every holding before flagging concentration: use the book's asset kind and description, and call lookup_symbols for any unlabeled ticker (it returns kind plus Yahoo top holdings/weights). Diversified ETFs/index funds are not single-name stocks — read those weights before recommending a trim. Overlap of the same issuer across funds is concentration; sleeve size in a broad index fund is not. Query options.etf_holdings when you need a lake-backed book.",
    );
  }
  if (opts.publish_to_timeline) {
    lines.push(
      "The owner opted to share this briefing on their public profile if it passes the quality gate. Still write it as a personal desk note, not a bot persona post. Call publish_desk after tools so the share can render specialist takes.",
    );
  } else {
    lines.push(
      "Do not write for a public feed. Write a comprehensive, direct personal briefing for the owner in plain markdown (headings, bullet points, and specific numbers). Do NOT call publish_desk — deliver the full analysis directly in markdown. Skip render_chart unless a figure clearly helps the owner. suggest_trades is optional and only when a concrete adjustment is tradable.",
    );
  }
  return lines.join("\n");
}

export function accountBotPublishDecision(opts: {
  publish_to_timeline: boolean;
  hasHandle: boolean;
}): { action: "keep_private"; reason?: string } | { action: "publish" } {
  if (!opts.publish_to_timeline) return { action: "keep_private" };
  if (!opts.hasHandle) {
    return { action: "keep_private", reason: "claim a public handle to publish" };
  }
  return { action: "publish" };
}

function rowToBot(row: UserBotRow): UserBot {
  const preset = resolveUserBotPreset(row.schedule_preset);
  const storedIds = parsePortfolioIdsJson(row.portfolio_ids);
  const fallbackSource = isUserBotPortfolioSource(row.portfolio_source)
    ? row.portfolio_source
    : (row.attach_portfolio === 1 ? "all" : "none");
  const fallbackAccount = typeof row.portfolio_account_id === "string"
    ? row.portfolio_account_id.trim() || null
    : null;
  const portfolio = storedIds
    ? derivePortfolioFromIds(storedIds)
    : derivePortfolioFromIds(
      fallbackSource === "none"
        ? []
        : fallbackSource === "paper"
          ? ["paper"]
          : fallbackSource === "all"
            ? ["paper", "schwab"]
            : [portfolioOptionId("schwab", fallbackAccount)],
    );
  return {
    bot_id: row.bot_id,
    user_id: row.user_id,
    name: row.name,
    prompt: row.prompt,
    schedule_preset: preset?.id ?? "hourly_market",
    cadence_seconds: row.cadence_seconds,
    market_gated: row.market_gated === 1,
    attach_portfolio: portfolio.source !== "none",
    portfolio_source: portfolio.source,
    portfolio_account_id: portfolio.accountId,
    portfolio_account_ids: portfolio.accountIds,
    portfolio_id: portfolioOptionId(portfolio.source, portfolio.accountId),
    portfolio_ids: portfolio.ids,
    publish_to_timeline: row.publish_to_timeline === 1,
    email_alerts: row.email_alerts === 1,
    enabled: row.enabled === 1,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_run_id: row.last_run_id,
    consecutive_failures: row.consecutive_failures,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRun(row: RunRow): UserBotRun {
  const status: UserBotRunStatus =
    row.status === "queued"
    || row.status === "running"
    || row.status === "completed"
    || row.status === "shared"
    || row.status === "failed"
      ? row.status
      : "failed";
  return {
    run_id: row.run_id,
    bot_id: row.bot_id,
    user_id: row.user_id,
    chat_id: row.chat_id,
    share_id: row.share_id,
    prompt: row.prompt,
    status,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function countUserBots(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM user_bots WHERE user_id = ?1",
  ).bind(userId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function listUserBots(db: D1Database, userId: string): Promise<UserBot[]> {
  const rows = await db.prepare(
    "SELECT * FROM user_bots WHERE user_id = ?1 ORDER BY updated_at DESC",
  ).bind(userId).all<UserBotRow>();
  return (rows.results ?? []).map(rowToBot);
}

export async function getUserBot(db: D1Database, botId: string): Promise<UserBot | null> {
  const id = botId.trim();
  if (!id) return null;
  const row = await db.prepare("SELECT * FROM user_bots WHERE bot_id = ?1").bind(id).first<UserBotRow>();
  return row ? rowToBot(row) : null;
}

export async function getOwnedUserBot(
  db: D1Database,
  userId: string,
  botId: string,
): Promise<UserBot | null> {
  const bot = await getUserBot(db, botId);
  if (!bot || bot.user_id !== userId) return null;
  return bot;
}

export async function createUserBot(
  db: D1Database,
  userId: string,
  body: UserBotInput,
  env?: MarketHoursEnv,
): Promise<{ ok: true; bot: UserBot } | { ok: false; status: 400 | 409; error: string }> {
  const validated = validateUserBotInput(body);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  if (validated.value.publish_to_timeline) {
    const handle = await getHandle(db, userId);
    if (!handle) {
      return { ok: false, status: 400, error: "claim a public handle before publishing to the timeline" };
    }
  }
  const count = await countUserBots(db, userId);
  if (count >= USER_BOT_MAX_PER_USER) {
    return { ok: false, status: 409, error: `you can have up to ${USER_BOT_MAX_PER_USER} bots` };
  }
  const now = Date.now();
  const bot_id = crypto.randomUUID();
  const next = nextScheduleWakeMs(now, validated.value.cadence_seconds, {
    marketGated: validated.value.market_gated,
    env,
  });
  await db.prepare(
    `INSERT INTO user_bots
       (bot_id, user_id, name, prompt, schedule_preset, cadence_seconds, market_gated,
        attach_portfolio, portfolio_source, portfolio_account_id, portfolio_ids,
        publish_to_timeline, email_alerts, enabled, next_run_at,
        last_run_at, last_run_id, consecutive_failures, last_error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, NULL, 0, NULL, ?16, ?16)`,
  ).bind(
    bot_id,
    userId,
    validated.value.name,
    validated.value.prompt,
    validated.value.schedule_preset,
    validated.value.cadence_seconds,
    validated.value.market_gated ? 1 : 0,
    validated.value.attach_portfolio ? 1 : 0,
    validated.value.portfolio_source,
    validated.value.portfolio_account_id,
    JSON.stringify(validated.value.portfolio_ids),
    validated.value.publish_to_timeline ? 1 : 0,
    validated.value.email_alerts ? 1 : 0,
    validated.value.enabled ? 1 : 0,
    next,
    now,
  ).run();
  const bot = await getUserBot(db, bot_id);
  if (!bot) return { ok: false, status: 400, error: "failed to create bot" };
  return { ok: true, bot };
}

export async function updateUserBot(
  db: D1Database,
  userId: string,
  botId: string,
  body: UserBotInput,
  env?: MarketHoursEnv,
): Promise<{ ok: true; bot: UserBot } | { ok: false; status: 400 | 404; error: string }> {
  const existing = await getOwnedUserBot(db, userId, botId);
  if (!existing) return { ok: false, status: 404, error: "not found" };
  const validated = validateUserBotInput(body, existing);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  if (validated.value.publish_to_timeline && !existing.publish_to_timeline) {
    const handle = await getHandle(db, userId);
    if (!handle) {
      return { ok: false, status: 400, error: "claim a public handle before publishing to the timeline" };
    }
  }
  const now = Date.now();
  const scheduleChanged =
    validated.value.schedule_preset !== existing.schedule_preset
    || validated.value.cadence_seconds !== existing.cadence_seconds
    || validated.value.market_gated !== existing.market_gated;
  const next = scheduleChanged
    ? nextScheduleWakeMs(now, validated.value.cadence_seconds, {
      marketGated: validated.value.market_gated,
      env,
    })
    : existing.next_run_at;
  await db.prepare(
    `UPDATE user_bots SET
       name = ?2, prompt = ?3, schedule_preset = ?4, cadence_seconds = ?5,
       market_gated = ?6, attach_portfolio = ?7, portfolio_source = ?8,
       portfolio_account_id = ?9, portfolio_ids = ?10, publish_to_timeline = ?11,
       email_alerts = ?12, enabled = ?13, next_run_at = ?14, updated_at = ?15
     WHERE bot_id = ?1 AND user_id = ?16`,
  ).bind(
    existing.bot_id,
    validated.value.name,
    validated.value.prompt,
    validated.value.schedule_preset,
    validated.value.cadence_seconds,
    validated.value.market_gated ? 1 : 0,
    validated.value.attach_portfolio ? 1 : 0,
    validated.value.portfolio_source,
    validated.value.portfolio_account_id,
    JSON.stringify(validated.value.portfolio_ids),
    validated.value.publish_to_timeline ? 1 : 0,
    validated.value.email_alerts ? 1 : 0,
    validated.value.enabled ? 1 : 0,
    next,
    now,
    userId,
  ).run();
  const bot = await getUserBot(db, existing.bot_id);
  if (!bot) return { ok: false, status: 404, error: "not found" };
  return { ok: true, bot };
}

export async function deleteUserBot(
  db: D1Database,
  userId: string,
  botId: string,
): Promise<boolean> {
  const existing = await getOwnedUserBot(db, userId, botId);
  if (!existing) return false;
  await db.prepare("DELETE FROM user_bot_runs WHERE bot_id = ?1").bind(existing.bot_id).run();
  const result = await db.prepare(
    "DELETE FROM user_bots WHERE bot_id = ?1 AND user_id = ?2",
  ).bind(existing.bot_id, userId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function listDueUserBots(db: D1Database, nowMs = Date.now()): Promise<UserBot[]> {
  const rows = await db.prepare(
    `SELECT * FROM user_bots WHERE enabled = 1 AND next_run_at <= ?1 ORDER BY next_run_at ASC LIMIT 20`,
  ).bind(nowMs).all<UserBotRow>();
  return (rows.results ?? []).map(rowToBot);
}

export async function markUserBotSuccess(
  db: D1Database,
  botId: string,
  runId: string,
  nowMs: number,
  env?: MarketHoursEnv,
): Promise<UserBot | null> {
  const bot = await getUserBot(db, botId);
  if (!bot) return null;
  const next = nextScheduleWakeMs(nowMs, bot.cadence_seconds, {
    marketGated: bot.market_gated,
    env,
  });
  await db.prepare(
    `UPDATE user_bots SET
       last_run_at = ?2, last_run_id = ?3, next_run_at = ?4,
       consecutive_failures = 0, last_error = NULL, updated_at = ?2
     WHERE bot_id = ?1`,
  ).bind(botId, nowMs, runId, next).run();
  return getUserBot(db, botId);
}

export async function markUserBotFailure(
  db: D1Database,
  botId: string,
  error: string,
  nowMs: number,
  env?: MarketHoursEnv,
): Promise<UserBot | null> {
  const bot = await getUserBot(db, botId);
  if (!bot) return null;
  const failures = bot.consecutive_failures + 1;
  const backoffMs = Math.min(
    bot.cadence_seconds * 1000,
    Math.min(15 * 60_000 * failures, 60 * 60_000),
  );
  const next = bot.market_gated
    ? nextScheduleWakeMs(nowMs, bot.cadence_seconds, { marketGated: true, env })
    : nowMs + backoffMs;
  await db.prepare(
    `UPDATE user_bots SET
       consecutive_failures = ?2, last_error = ?3, next_run_at = ?4, updated_at = ?5
     WHERE bot_id = ?1`,
  ).bind(botId, failures, error.slice(0, 2000), next, nowMs).run();
  return getUserBot(db, botId);
}

export async function deferUserBot(
  db: D1Database,
  botId: string,
  nextRunAt: number,
  nowMs: number,
): Promise<void> {
  await db.prepare(
    "UPDATE user_bots SET next_run_at = ?2, updated_at = ?3 WHERE bot_id = ?1",
  ).bind(botId, nextRunAt, nowMs).run();
}

export function userBotRunExpiryCutoff(nowMs = Date.now()): number {
  return nowMs - USER_BOT_RUN_TIMEOUT_MS;
}

export async function expireStuckUserBotRuns(db: D1Database, nowMs = Date.now()): Promise<number> {
  const cutoff = userBotRunExpiryCutoff(nowMs);
  const result = await db.prepare(
    `UPDATE user_bot_runs
     SET status = 'failed', error = ?1, updated_at = ?2
     WHERE status IN ('queued', 'running') AND created_at < ?3`,
  ).bind(USER_BOT_RUN_TIMEOUT_ERROR, nowMs, cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

/** Manual Run now: drop this bot's in-flight row if it is older than maxAgeMs. */
export async function expireStaleActiveUserBotRun(
  db: D1Database,
  botId: string,
  maxAgeMs = USER_BOT_FORCE_STALE_MS,
  nowMs = Date.now(),
): Promise<number> {
  const cutoff = nowMs - maxAgeMs;
  const result = await db.prepare(
    `UPDATE user_bot_runs
     SET status = 'failed', error = ?1, updated_at = ?2
     WHERE bot_id = ?3 AND status IN ('queued', 'running') AND created_at < ?4`,
  ).bind("stale run replaced by Run now", nowMs, botId, cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

export async function hasActiveUserBotRun(db: D1Database, botId: string): Promise<boolean> {
  return Boolean(await getActiveUserBotRun(db, botId));
}

export async function getActiveUserBotRun(db: D1Database, botId: string): Promise<UserBotRun | null> {
  const row = await db.prepare(
    `SELECT * FROM user_bot_runs
     WHERE bot_id = ?1 AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(botId).first<RunRow>();
  return row ? rowToRun(row) : null;
}

export async function createUserBotRun(
  db: D1Database,
  bot: UserBot,
  chatId: string,
  prompt: string,
): Promise<UserBotRun> {
  await expireStuckUserBotRuns(db);
  const run_id = crypto.randomUUID();
  const now = Date.now();
  const clipped = prompt.slice(0, USER_BOT_PROMPT_MAX);
  await db.prepare(
    `INSERT INTO user_bot_runs
       (run_id, bot_id, user_id, chat_id, share_id, prompt, status, error, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'queued', NULL, ?6, ?6)`,
  ).bind(run_id, bot.bot_id, bot.user_id, chatId, clipped, now).run();
  return {
    run_id,
    bot_id: bot.bot_id,
    user_id: bot.user_id,
    chat_id: chatId,
    share_id: null,
    prompt: clipped,
    status: "queued",
    error: null,
    created_at: now,
    updated_at: now,
  };
}

export async function updateUserBotRun(
  db: D1Database,
  runId: string,
  patch: { status?: UserBotRunStatus; share_id?: string | null; error?: string | null },
): Promise<UserBotRun | null> {
  const row = await db.prepare("SELECT * FROM user_bot_runs WHERE run_id = ?1").bind(runId).first<RunRow>();
  if (!row) return null;
  const status = patch.status ?? row.status;
  const share_id = patch.share_id === undefined ? row.share_id : patch.share_id;
  const error = patch.error === undefined ? row.error : patch.error;
  const now = Date.now();
  await db.prepare(
    "UPDATE user_bot_runs SET status = ?2, share_id = ?3, error = ?4, updated_at = ?5 WHERE run_id = ?1",
  ).bind(runId, status, share_id, error, now).run();
  return rowToRun({ ...row, status, share_id, error, updated_at: now });
}

export async function listUserBotRuns(
  db: D1Database,
  botId: string,
  limit = 20,
): Promise<UserBotRun[]> {
  await expireStuckUserBotRuns(db);
  const rows = await db.prepare(
    `SELECT * FROM user_bot_runs WHERE bot_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  ).bind(botId, Math.min(Math.max(limit, 1), 100)).all<RunRow>();
  return (rows.results ?? []).map(rowToRun);
}

export async function getUserEmail(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT email FROM "user" WHERE id = ?1`,
  ).bind(userId).first<{ email: string }>();
  const email = typeof row?.email === "string" ? row.email.trim() : "";
  return email || null;
}
