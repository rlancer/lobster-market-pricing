/**
 * Server-side bot chat runner — schedule / admin trigger without a browser.
 *
 * Mints a bot_run + CopilotAgent DO, runs one headless turn, then inserts a
 * shared_chats row. Finished answers stamp bot_handle (timeline); the quality
 * gate holds incomplete runs as unlisted shares and marks the run failed.
 */
import {
  createBotRun,
  getBotProfile,
  updateBotRun,
  type BotEnv,
  type BotProfile,
  type BotRun,
} from "./bots";
import {
  deferSchedule,
  getBotSchedule,
  hasActiveBotRun,
  listDueBotSchedules,
  markScheduleFailure,
  markScheduleSuccess,
  scheduleRunDecision,
  type BotSchedule,
} from "./bot-schedule";
import type { MarketHoursEnv } from "./market-hours";
import { enrichChatMeta } from "./chat-meta";
import { createCopilotModel } from "./copilot-contract";
import type { ShareTurn } from "./share-turns";
import { moderateTimelineShare } from "./timeline-moderation";
import { scheduleImprovementReport, type ImprovementReporterEnv } from "./improvement-reporter";
import { clipTitle, TITLE_MAX } from "./user-chats";

const SHARE_MAX_CONTENT = 5_000;
const SHARE_MAX_SQL = 10_000;
const SHARE_MAX_REASONING = 20_000;
const SHARE_MAX_TITLE = TITLE_MAX;
const SHARE_ID_BYTES = 18;
const SHARE_ROW_MAX_BYTES = 2_000_000;

export interface BotRunnerEnv extends BotEnv, MarketHoursEnv, ImprovementReporterEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CopilotAgent: DurableObjectNamespace<any>;
  COPILOT_MODEL?: string;
  OPEN_ROUTER_KEY?: string;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function base62Encode(bytes: Uint8Array): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/** Cap share turns for bot auto-share (desk + trades + chart/sql preserved). */
export function capShareMessages(messages: ShareTurn[], titleOverride?: string | null): { messages: Record<string, unknown>[]; title: string | null; sourceSql: string | null } {
  const capped = messages.map((m) => {
    const out: Record<string, unknown> = {
      role: m.role,
      content: (m.content ?? "").slice(0, SHARE_MAX_CONTENT),
    };
    if (m.reasoning) out.reasoning = m.reasoning.slice(0, SHARE_MAX_REASONING);
    if (m.sql) out.sql = m.sql.slice(0, SHARE_MAX_SQL);
    if (m.chart) out.chart = m.chart;
    if (m.desk) out.desk = m.desk;
    if (m.trades) out.trades = m.trades;
    if (typeof m.ts === "number") out.ts = m.ts;
    return out;
  });
  const firstUser = capped.find((m) => m.role === "user" && typeof m.content === "string" && m.content);
  const clipped =
    typeof firstUser?.content === "string" ? clipTitle(firstUser.content, SHARE_MAX_TITLE) : null;
  const title = (typeof titleOverride === "string" && titleOverride.trim()
    ? clipTitle(titleOverride, SHARE_MAX_TITLE)
    : null) || clipped;
  let sourceSql: string | null = null;
  for (let i = capped.length - 1; i >= 0; i--) {
    if (capped[i].role === "assistant" && typeof capped[i].sql === "string") {
      sourceSql = String(capped[i].sql);
      break;
    }
  }
  while (capped.length > 1 && utf8Bytes(JSON.stringify(capped)) > 1_200_000) capped.shift();
  return { messages: capped, title, sourceSql };
}

async function mintBotShare(
  env: BotRunnerEnv,
  args: {
    chatId: string;
    runId: string;
    botHandle: string;
    model: string | null;
    messages: ShareTurn[];
    startedAt: number;
    endedAt: number;
    title?: string | null;
  },
  opts?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<{ ok: true; share_id: string } | { ok: false; error: string }> {
  const existing = await env.SCHEMA_DB.prepare(
    `SELECT share_id FROM shared_chats WHERE run_id = ?1`,
  ).bind(args.runId).first<{ share_id: string }>();
  if (existing?.share_id) {
    await updateBotRun(env.SCHEMA_DB, args.runId, { status: "shared", share_id: existing.share_id });
    return { ok: true, share_id: existing.share_id };
  }

  const { messages, title, sourceSql } = capShareMessages(args.messages, args.title);
  if (!messages.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())) {
    return { ok: false, error: "no assistant content to share" };
  }

  // Same quality gate as human publish — incomplete / cut-off runs stay off
  // the public feed. Mint an unlisted share (no bot_handle) for audit, and
  // mark the run failed so schedules do not treat junk as a successful post.
  const moderationModel = env.OPEN_ROUTER_KEY?.trim() && env.COPILOT_MODEL?.trim()
    ? createCopilotModel(
      { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY, COPILOT_MODEL: env.COPILOT_MODEL },
      "https://lobster.mp",
    )
    : null;
  const moderation = await moderateTimelineShare(messages, moderationModel);
  const onTimeline = moderation.allow;
  if (!onTimeline) {
    console.info(JSON.stringify({
      timelineModeration: true,
      action: "reject_bot_share",
      run_id: args.runId,
      bot_handle: args.botHandle,
      source: moderation.source,
      reason: moderation.reason,
    }));
  }

  const messagesJson = JSON.stringify(messages);
  const rowBytes = utf8Bytes(messagesJson) + utf8Bytes(sourceSql ?? "") + 512;
  if (rowBytes > SHARE_ROW_MAX_BYTES) return { ok: false, error: "share payload too large" };

  const shareId = base62Encode(crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES)));
  const now = Date.now();
  try {
    await env.SCHEMA_DB.prepare(
      `INSERT INTO shared_chats
         (share_id, chat_id, title, mode, model, messages, source_sql, created_ip, created_ua, created_at, updated_at, bot_handle, run_id)
       VALUES (?1, ?2, ?3, 'funded', ?4, ?5, ?6, 'bot-schedule', 'bot-runner', ?7, ?7, ?8, ?9)`,
    ).bind(
      shareId,
      args.chatId,
      title,
      args.model,
      messagesJson,
      sourceSql,
      now,
      onTimeline ? args.botHandle : null,
      args.runId,
    ).run();
    scheduleImprovementReport(
      env,
      moderationModel,
      {
        messages,
        decision: moderation,
        action: onTimeline ? "allow_bot_share" : "reject_bot_share",
        shareId,
        runId: args.runId,
        botHandle: args.botHandle,
        publicOrigin: "https://lobster.mp",
        model: args.model,
      },
      { waitUntil: opts?.waitUntil },
    );
    if (onTimeline) {
      await updateBotRun(env.SCHEMA_DB, args.runId, { status: "shared", share_id: shareId });
      return { ok: true, share_id: shareId };
    }
    const error = `timeline quality: ${moderation.reason}`;
    await updateBotRun(env.SCHEMA_DB, args.runId, {
      status: "failed",
      share_id: shareId,
      error,
    });
    return { ok: false, error };
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      const byRun = await env.SCHEMA_DB.prepare(
        `SELECT share_id, bot_handle FROM shared_chats WHERE run_id = ?1`,
      ).bind(args.runId).first<{ share_id: string; bot_handle: string | null }>();
      if (byRun?.share_id) {
        if (byRun.bot_handle) {
          await updateBotRun(env.SCHEMA_DB, args.runId, { status: "shared", share_id: byRun.share_id });
          return { ok: true, share_id: byRun.share_id };
        }
        const rejected = `timeline quality: ${moderation.reason}`;
        await updateBotRun(env.SCHEMA_DB, args.runId, {
          status: "failed",
          share_id: byRun.share_id,
          error: rejected,
        });
        return { ok: false, error: rejected };
      }
    }
    console.error("bot share mint failed", error);
    return { ok: false, error: "storage unavailable" };
  }
}

type HeadlessAgent = {
  runHeadlessBotTurn: (input: {
    prompt: string;
    bot: {
      handle: string;
      display_name: string;
      persona: string;
      system_prompt_extra?: string;
      model?: string | null;
      reasoning_effort?: string | null;
    };
  }) => Promise<{
    status: "completed" | "error" | "skipped" | "aborted";
    error?: string;
    model: string | null;
    messages: ShareTurn[];
  }>;
};

/**
 * Run one bot chat end-to-end (Copilot DO + timeline share).
 * Prompt is used as-is (scheduled repeats allowed).
 */
export async function runBotChatAndShare(
  env: BotRunnerEnv,
  bot: BotProfile,
  prompt: string,
  opts?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<
  | { ok: true; run: BotRun; share_id: string; chat_id: string }
  | { ok: false; error: string; run?: BotRun }
> {
  if (!bot.enabled) return { ok: false, error: "bot is disabled" };
  if (!env.OPEN_ROUTER_KEY?.trim() || !env.COPILOT_MODEL?.trim()) {
    return { ok: false, error: "Copilot is not configured" };
  }
  if (await hasActiveBotRun(env.SCHEMA_DB, bot.handle)) {
    return { ok: false, error: "bot already has a run in progress" };
  }

  const chatId = crypto.randomUUID();
  const run = await createBotRun(env.SCHEMA_DB, bot.handle, chatId, prompt);
  await updateBotRun(env.SCHEMA_DB, run.run_id, { status: "running" });
  const startedAt = Date.now();

  try {
    // DO stub by chat id — cast avoids deep Agent generics from getAgentByName.
    const agent = (env.CopilotAgent as DurableObjectNamespace).getByName(chatId) as unknown as HeadlessAgent;
    const turn = await agent.runHeadlessBotTurn({
      prompt,
      bot: {
        handle: bot.handle,
        display_name: bot.display_name,
        persona: bot.persona,
        system_prompt_extra: bot.system_prompt_extra,
        model: bot.model,
        reasoning_effort: bot.reasoning_effort,
      },
    });
    if (turn.status !== "completed") {
      const error = turn.error || `turn ${turn.status}`;
      await updateBotRun(env.SCHEMA_DB, run.run_id, { status: "failed", error });
      return { ok: false, error, run: { ...run, status: "failed", error } };
    }

    // Cheap title + ticker NER after the desk turn — clipTitle remains the fallback.
    let metaTitle: string | null = null;
    try {
      const model = createCopilotModel(
        { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY!, COPILOT_MODEL: env.COPILOT_MODEL! },
        "https://lobster.mp",
      );
      const meta = await enrichChatMeta(env, chatId, turn.messages, model);
      metaTitle = meta.title;
    } catch (error) {
      console.warn("bot chat-meta enrich failed", error);
    }

    const share = await mintBotShare(env, {
      chatId,
      runId: run.run_id,
      botHandle: bot.handle,
      model: turn.model,
      messages: turn.messages,
      startedAt,
      endedAt: Date.now(),
      title: metaTitle,
    }, { waitUntil: opts?.waitUntil });
    if (!share.ok) {
      await updateBotRun(env.SCHEMA_DB, run.run_id, { status: "failed", error: share.error });
      return { ok: false, error: share.error, run };
    }
    const updated = await updateBotRun(env.SCHEMA_DB, run.run_id, { status: "shared", share_id: share.share_id });
    return {
      ok: true,
      run: updated ?? { ...run, status: "shared", share_id: share.share_id },
      share_id: share.share_id,
      chat_id: chatId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateBotRun(env.SCHEMA_DB, run.run_id, { status: "failed", error: message });
    return { ok: false, error: message, run };
  }
}

export async function runOneBotSchedule(
  env: BotRunnerEnv,
  schedule: BotSchedule,
  opts?: { force?: boolean; waitUntil?: (p: Promise<unknown>) => void },
): Promise<
  | { ok: true; deferred?: false; run: BotRun; share_id: string }
  | { ok: true; deferred: true; reason: string; next_run_at: number }
  | { ok: false; error: string }
> {
  const now = Date.now();
  if (!opts?.force) {
    const decision = scheduleRunDecision(schedule, now, env);
    if (decision.action === "skip") return { ok: false, error: decision.reason };
    if (decision.action === "defer") {
      await deferSchedule(env.SCHEMA_DB, schedule.handle, decision.next_run_at, now);
      return { ok: true, deferred: true, reason: decision.reason, next_run_at: decision.next_run_at };
    }
  }

  const bot = await getBotProfile(env.SCHEMA_DB, schedule.handle);
  if (!bot || !bot.enabled) {
    await markScheduleFailure(env.SCHEMA_DB, schedule.handle, "bot missing or disabled", now, env);
    return { ok: false, error: "bot missing or disabled" };
  }

  const result = await runBotChatAndShare(env, bot, schedule.prompt, { waitUntil: opts?.waitUntil });
  if (!result.ok) {
    await markScheduleFailure(env.SCHEMA_DB, schedule.handle, result.error, now, env);
    return { ok: false, error: result.error };
  }
  await markScheduleSuccess(env.SCHEMA_DB, schedule.handle, result.run.run_id, now, env);
  return { ok: true, run: result.run, share_id: result.share_id };
}

/** Cron entry — process due schedules sequentially (single-flight per handle). */
export async function runDueBotSchedules(
  env: BotRunnerEnv,
  opts?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<{
  processed: number;
  ran: number;
  deferred: number;
  failed: number;
  results: Array<{ handle: string; status: string; detail?: string }>;
}> {
  const due = await listDueBotSchedules(env.SCHEMA_DB);
  const results: Array<{ handle: string; status: string; detail?: string }> = [];
  let ran = 0;
  let deferred = 0;
  let failed = 0;
  for (const schedule of due) {
    try {
      const live = await getBotSchedule(env.SCHEMA_DB, schedule.handle);
      if (!live || !live.enabled) continue;
      const outcome = await runOneBotSchedule(env, live, { waitUntil: opts?.waitUntil });
      if (outcome.ok && outcome.deferred) {
        deferred += 1;
        results.push({ handle: schedule.handle, status: "deferred", detail: outcome.reason });
      } else if (outcome.ok) {
        ran += 1;
        results.push({ handle: schedule.handle, status: "shared", detail: outcome.share_id });
      } else {
        failed += 1;
        results.push({ handle: schedule.handle, status: "failed", detail: outcome.error });
      }
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await markScheduleFailure(env.SCHEMA_DB, schedule.handle, detail, Date.now(), env);
      results.push({ handle: schedule.handle, status: "failed", detail });
    }
  }
  return { processed: due.length, ran, deferred, failed, results };
}
