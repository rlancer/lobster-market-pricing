/**
 * Admin-editable Copilot bot profiles.
 *
 * Bots claim public handles in the same namespace as user_profiles (e.g.
 * nowlobster, yololobster) and stamp shared_chats.bot_handle when their chats
 * are shared. CRUD + generate require a product-admin session (or ADMIN_TOKEN).
 */
import { isAdminEmail } from "./admin";
import { getSessionUser, type AuthEnv, type SessionUser } from "./auth";
import { parseHandle } from "./profiles";

const DISPLAY_NAME_MAX = 80;
const PERSONA_MAX = 200;
const BIO_MAX = 2_000;
const SYSTEM_EXTRA_MAX = 1_000;
const SEED_PROMPTS_MAX = 20;
const SEED_PROMPT_MAX = 4_000;
const MODEL_MAX = 120;
const REASONING_EFFORTS = new Set(["xhigh", "high", "medium", "low", "minimal", "none"]);

/** Abandoned / hung generate runs older than this are marked failed. */
export const BOT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const BOT_RUN_TIMEOUT_ERROR = "timed out waiting for completion";

export interface BotEnv extends AuthEnv {
  SCHEMA_DB: D1Database;
  ADMIN_TOKEN?: string;
}

export interface BotProfile {
  handle: string;
  display_name: string;
  persona: string;
  bio: string | null;
  system_prompt_extra: string;
  seed_prompts: string[];
  model: string | null;
  reasoning_effort: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface BotRun {
  run_id: string;
  handle: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: "queued" | "running" | "shared" | "failed";
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface BotProfileInput {
  handle?: unknown;
  display_name?: unknown;
  persona?: unknown;
  bio?: unknown;
  system_prompt_extra?: unknown;
  seed_prompts?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  enabled?: unknown;
}

type BotRow = {
  handle: string;
  display_name: string;
  persona: string;
  bio: string | null;
  system_prompt_extra: string;
  seed_prompts: string;
  model: string | null;
  reasoning_effort: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  run_id: string;
  handle: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
};

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function parseSeedPrompts(raw: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: [] };
  let list: unknown[] = [];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return { ok: false, error: "seed_prompts must be a JSON array" };
      list = parsed;
    } catch {
      return { ok: false, error: "seed_prompts must be valid JSON" };
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  } else {
    return { ok: false, error: "seed_prompts must be an array" };
  }
  if (list.length > SEED_PROMPTS_MAX) {
    return { ok: false, error: `seed_prompts exceeds ${SEED_PROMPTS_MAX} entries` };
  }
  const value: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") return { ok: false, error: "each seed prompt must be a string" };
    const prompt = item.trim().slice(0, SEED_PROMPT_MAX);
    if (prompt) value.push(prompt);
  }
  return { ok: true, value };
}

function rowToProfile(row: BotRow): BotProfile {
  let seed_prompts: string[] = [];
  try {
    const parsed = JSON.parse(row.seed_prompts) as unknown;
    if (Array.isArray(parsed)) {
      seed_prompts = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    seed_prompts = [];
  }
  return {
    handle: row.handle,
    display_name: row.display_name,
    persona: row.persona,
    bio: row.bio,
    system_prompt_extra: row.system_prompt_extra,
    seed_prompts,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRun(row: RunRow): BotRun {
  const status =
    row.status === "queued" || row.status === "running" || row.status === "shared" || row.status === "failed"
      ? row.status
      : "failed";
  return {
    run_id: row.run_id,
    handle: row.handle,
    chat_id: row.chat_id,
    share_id: row.share_id,
    prompt: row.prompt,
    status,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Constant-time string comparison for the admin token (length is not secret). */
function secureEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function adminTokenAuthorized(req: Request, env: BotEnv): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token.length > 0 && secureEqual(token, expected);
}

/** Product admin session or ADMIN_TOKEN bearer. */
export async function requireBotAdmin(
  env: BotEnv,
  req: Request,
): Promise<{ ok: true; user: SessionUser | null } | { ok: false; status: 401; error: string }> {
  if (adminTokenAuthorized(req, env)) return { ok: true, user: null };
  const user = await getSessionUser(env, req);
  if (!user || !isAdminEmail(user.email)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, user };
}

export function validateBotInput(
  body: BotProfileInput,
  opts: { requireHandle: boolean },
): { ok: true; value: Omit<BotProfile, "created_at" | "updated_at"> } | { ok: false; error: string } {
  let handle = "";
  if (opts.requireHandle || body.handle != null) {
    const parsed = parseHandle(body.handle);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    handle = parsed.handle;
  }
  const display_name = str(body.display_name, DISPLAY_NAME_MAX);
  if (!display_name) return { ok: false, error: "display_name is required" };
  const persona = str(body.persona, PERSONA_MAX);
  if (!persona) return { ok: false, error: "persona is required" };
  const bio = typeof body.bio === "string" ? body.bio.trim().slice(0, BIO_MAX) || null : null;
  const system_prompt_extra =
    typeof body.system_prompt_extra === "string" ? body.system_prompt_extra.trim().slice(0, SYSTEM_EXTRA_MAX) : "";
  const seeds = parseSeedPrompts(body.seed_prompts);
  if (!seeds.ok) return { ok: false, error: seeds.error };
  const model = typeof body.model === "string" ? body.model.trim().slice(0, MODEL_MAX) || null : null;
  let reasoning_effort: string | null = null;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.trim()) {
    const effort = body.reasoning_effort.trim().toLowerCase();
    if (!REASONING_EFFORTS.has(effort)) {
      return { ok: false, error: "reasoning_effort must be xhigh|high|medium|low|minimal|none" };
    }
    reasoning_effort = effort;
  }
  const enabled = body.enabled === false || body.enabled === 0 ? false : true;
  return {
    ok: true,
    value: {
      handle,
      display_name,
      persona,
      bio,
      system_prompt_extra,
      seed_prompts: seeds.value,
      model,
      reasoning_effort,
      enabled,
    },
  };
}

export async function listBotProfiles(db: D1Database, opts?: { enabledOnly?: boolean }): Promise<BotProfile[]> {
  const sql = opts?.enabledOnly
    ? "SELECT * FROM bot_profiles WHERE enabled = 1 ORDER BY handle ASC"
    : "SELECT * FROM bot_profiles ORDER BY handle ASC";
  const rows = await db.prepare(sql).all<BotRow>();
  return (rows.results ?? []).map(rowToProfile);
}

export async function getBotProfile(db: D1Database, handle: string): Promise<BotProfile | null> {
  const parsed = parseHandle(handle);
  if (!parsed.ok) return null;
  const row = await db.prepare("SELECT * FROM bot_profiles WHERE handle = ?1").bind(parsed.handle).first<BotRow>();
  return row ? rowToProfile(row) : null;
}

export async function handleTakenByUser(db: D1Database, handle: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS n FROM user_profiles WHERE handle = ?1").bind(handle).first();
  return Boolean(row);
}

export async function createBotProfile(
  db: D1Database,
  body: BotProfileInput,
): Promise<{ ok: true; profile: BotProfile } | { ok: false; status: 400 | 409; error: string }> {
  const validated = validateBotInput(body, { requireHandle: true });
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  if (await handleTakenByUser(db, validated.value.handle)) {
    return { ok: false, status: 409, error: "that handle is taken" };
  }
  const existing = await getBotProfile(db, validated.value.handle);
  if (existing) return { ok: false, status: 409, error: "that handle is taken" };
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT INTO bot_profiles
         (handle, display_name, persona, bio, system_prompt_extra, seed_prompts, model, reasoning_effort, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      validated.value.handle,
      validated.value.display_name,
      validated.value.persona,
      validated.value.bio,
      validated.value.system_prompt_extra,
      JSON.stringify(validated.value.seed_prompts),
      validated.value.model,
      validated.value.reasoning_effort,
      validated.value.enabled ? 1 : 0,
      now,
    ).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return { ok: false, status: 409, error: "that handle is taken" };
    }
    throw error;
  }
  const profile = await getBotProfile(db, validated.value.handle);
  if (!profile) return { ok: false, status: 400, error: "failed to create bot" };
  return { ok: true, profile };
}

export async function updateBotProfile(
  db: D1Database,
  handleRaw: string,
  body: BotProfileInput,
): Promise<{ ok: true; profile: BotProfile } | { ok: false; status: 400 | 404; error: string }> {
  const existing = await getBotProfile(db, handleRaw);
  if (!existing) return { ok: false, status: 404, error: "not found" };
  const validated = validateBotInput(
    {
      ...body,
      handle: existing.handle,
      display_name: body.display_name ?? existing.display_name,
      persona: body.persona ?? existing.persona,
      bio: body.bio === undefined ? existing.bio : body.bio,
      system_prompt_extra: body.system_prompt_extra ?? existing.system_prompt_extra,
      seed_prompts: body.seed_prompts ?? existing.seed_prompts,
      model: body.model === undefined ? existing.model : body.model,
      reasoning_effort: body.reasoning_effort === undefined ? existing.reasoning_effort : body.reasoning_effort,
      enabled: body.enabled === undefined ? existing.enabled : body.enabled,
    },
    { requireHandle: true },
  );
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const now = Date.now();
  await db.prepare(
    `UPDATE bot_profiles SET
       display_name = ?2,
       persona = ?3,
       bio = ?4,
       system_prompt_extra = ?5,
       seed_prompts = ?6,
       model = ?7,
       reasoning_effort = ?8,
       enabled = ?9,
       updated_at = ?10
     WHERE handle = ?1`,
  ).bind(
    existing.handle,
    validated.value.display_name,
    validated.value.persona,
    validated.value.bio,
    validated.value.system_prompt_extra,
    JSON.stringify(validated.value.seed_prompts),
    validated.value.model,
    validated.value.reasoning_effort,
    validated.value.enabled ? 1 : 0,
    now,
  ).run();
  const profile = await getBotProfile(db, existing.handle);
  if (!profile) return { ok: false, status: 404, error: "not found" };
  return { ok: true, profile };
}

export async function deleteBotProfile(
  db: D1Database,
  handleRaw: string,
): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
  const existing = await getBotProfile(db, handleRaw);
  if (!existing) return { ok: false, status: 404, error: "not found" };
  // Detach shares first so the FK does not block delete; public shares remain.
  await db.prepare("UPDATE shared_chats SET bot_handle = NULL WHERE bot_handle = ?1").bind(existing.handle).run();
  await db.prepare("DELETE FROM bot_schedules WHERE handle = ?1").bind(existing.handle).run();
  await db.prepare("DELETE FROM bot_runs WHERE handle = ?1").bind(existing.handle).run();
  await db.prepare("DELETE FROM bot_profiles WHERE handle = ?1").bind(existing.handle).run();
  return { ok: true };
}

/** Cutoff timestamp: runs created before this (still queued/running) are expired. */
export function botRunExpiryCutoff(nowMs = Date.now()): number {
  return nowMs - BOT_RUN_TIMEOUT_MS;
}

/** Whether a run should be treated as timed out at `nowMs`. */
export function isBotRunTimedOut(
  status: BotRun["status"],
  createdAt: number,
  nowMs = Date.now(),
): boolean {
  return (status === "queued" || status === "running") && createdAt < botRunExpiryCutoff(nowMs);
}

/**
 * Mark queued/running bot_runs older than BOT_RUN_TIMEOUT_MS as failed.
 * Called from list/create paths so abandoned generates do not stay `running` forever.
 */
export async function expireStuckBotRuns(db: D1Database, nowMs = Date.now()): Promise<number> {
  const cutoff = botRunExpiryCutoff(nowMs);
  const result = await db.prepare(
    `UPDATE bot_runs
     SET status = 'failed', error = ?1, updated_at = ?2
     WHERE status IN ('queued', 'running') AND created_at < ?3`,
  ).bind(BOT_RUN_TIMEOUT_ERROR, nowMs, cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

/** Mark a single run failed with an error message. */
export async function failBotRun(db: D1Database, runId: string, error: string): Promise<BotRun | null> {
  return updateBotRun(db, runId, { status: "failed", error });
}

export async function createBotRun(
  db: D1Database,
  handle: string,
  chatId: string,
  prompt: string,
): Promise<BotRun> {
  await expireStuckBotRuns(db);
  const run_id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO bot_runs (run_id, handle, chat_id, share_id, prompt, status, error, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, 'queued', NULL, ?5, ?5)`,
  ).bind(run_id, handle, chatId, prompt.slice(0, SEED_PROMPT_MAX), now).run();
  return {
    run_id,
    handle,
    chat_id: chatId,
    share_id: null,
    prompt: prompt.slice(0, SEED_PROMPT_MAX),
    status: "queued",
    error: null,
    created_at: now,
    updated_at: now,
  };
}

export async function updateBotRun(
  db: D1Database,
  runId: string,
  patch: { status?: BotRun["status"]; share_id?: string | null; error?: string | null },
): Promise<BotRun | null> {
  const row = await db.prepare("SELECT * FROM bot_runs WHERE run_id = ?1").bind(runId).first<RunRow>();
  if (!row) return null;
  const status = patch.status ?? row.status;
  const share_id = patch.share_id === undefined ? row.share_id : patch.share_id;
  const error = patch.error === undefined ? row.error : patch.error;
  const now = Date.now();
  await db.prepare(
    `UPDATE bot_runs SET status = ?2, share_id = ?3, error = ?4, updated_at = ?5 WHERE run_id = ?1`,
  ).bind(runId, status, share_id, error, now).run();
  return rowToRun({ ...row, status, share_id, error, updated_at: now });
}

export async function getBotRun(db: D1Database, runId: string): Promise<BotRun | null> {
  const row = await db.prepare("SELECT * FROM bot_runs WHERE run_id = ?1").bind(runId).first<RunRow>();
  return row ? rowToRun(row) : null;
}

/**
 * Pure decision for POST /api/share/chat when `run_id` is present.
 * Reuse an existing share_id so the same bot run cannot mint duplicate
 * timeline posts; otherwise create and link a new shared_chats row.
 */
export function botShareReuseDecision(
  run: BotRun | null,
):
  | { action: "not_found" }
  | { action: "reuse"; share_id: string; handle: string }
  | { action: "create"; run_id: string; handle: string } {
  if (!run) return { action: "not_found" };
  const shareId = typeof run.share_id === "string" ? run.share_id.trim() : "";
  if (shareId) return { action: "reuse", share_id: shareId, handle: run.handle };
  return { action: "create", run_id: run.run_id, handle: run.handle };
}

export async function listBotRuns(db: D1Database, handle: string, limit = 20): Promise<BotRun[]> {
  await expireStuckBotRuns(db);
  const parsed = parseHandle(handle);
  if (!parsed.ok) return [];
  const rows = await db.prepare(
    `SELECT * FROM bot_runs WHERE handle = ?1 ORDER BY created_at DESC LIMIT ?2`,
  ).bind(parsed.handle, Math.min(Math.max(limit, 1), 100)).all<RunRow>();
  return (rows.results ?? []).map(rowToRun);
}

/** Recent run prompts for uniqueness checks when minting a new generate chat. */
export async function listBotRunPrompts(db: D1Database, handle: string, limit = 100): Promise<string[]> {
  const parsed = parseHandle(handle);
  if (!parsed.ok) return [];
  const rows = await db.prepare(
    `SELECT prompt FROM bot_runs WHERE handle = ?1 ORDER BY created_at DESC LIMIT ?2`,
  ).bind(parsed.handle, Math.min(Math.max(limit, 1), 200)).all<{ prompt: string }>();
  return (rows.results ?? [])
    .map((row) => (typeof row.prompt === "string" ? row.prompt : ""))
    .filter(Boolean);
}

/** Persona block appended to the base Copilot system prompt. */
export function botSystemAddon(profile: Pick<BotProfile, "handle" | "display_name" | "persona" | "system_prompt_extra">): string {
  const lines = [
    "",
    `Bot persona (@${profile.handle} — ${profile.display_name}):`,
    profile.persona,
  ];
  if (profile.system_prompt_extra.trim()) {
    lines.push(profile.system_prompt_extra.trim());
  }
  lines.push(
    "Write in this persona's voice while still following every SQL/tool rule above.",
    "You are generating a public post for this bot's timeline — be opinionated within the persona, keep claims grounded in tool results, and close with a sharp 1–3 sentence takeaway.",
    "Public timeline posts should include a figure when the answer has chartable series (index/ETF closes, sector moves, IV smile/surface, volume or OI leaders). After the chartable query, MUST call render_chart so the feed can paint it — narrating a chart without that tool leaves the post blank.",
    "Timeline posts MUST still call publish_desk after tools so the feed can render the active specialist personas plus a weighed overview. Write each specialist take AND the overview in this bot's voice — do not collapse the desk into a single prose blob. suggest_trades is optional unless you have a tradable idea.",
  );
  return lines.join("\n");
}
