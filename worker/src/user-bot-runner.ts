/**
 * Server-side runner for signed-in account bots.
 *
 * Runs one headless Chat turn, backs up the transcript, emails the owner,
 * then claims the chat into history. Timeline publish is opt-in and uses a
 * human share (no bot_handle). Claim happens after the turn so opening Chat
 * mid-run cannot abort the Durable Object RPC.
 */
import type { EmailSendBinding } from "./admin-email-test";
import { scheduleRunDecision } from "./bot-schedule";
import { capShareMessages } from "./bot-runner";
import { enrichChatMeta } from "./chat-meta";
import { createChatModel } from "./chat-contract";
import type { MarketHoursEnv } from "./market-hours";
import { getHandle } from "./profiles";
import type { ShareTurn } from "./share-turns";
import { excerptFromMessages, flagsFromMessages, recordShareOwner } from "./timeline";
import { moderateTimelineShare } from "./timeline-moderation";
import { claimChat, clipTitle } from "./user-chats";
import {
  accountBotPublishDecision,
  createUserBotRun,
  deferUserBot,
  expireStaleActiveUserBotRun,
  expireStuckUserBotRuns,
  getActiveUserBotRun,
  getUserBot,
  getUserEmail,
  listDueUserBots,
  markUserBotFailure,
  markUserBotSuccess,
  updateUserBotRun,
  type UserBot,
  type UserBotRun,
} from "./user-bots";
import { assistantBriefingFromTurns, sendUserBotAlert } from "./user-bot-email";

const SHARE_ID_BYTES = 18;
const SHARE_ROW_MAX_BYTES = 2_000_000;
const PUBLIC_ORIGIN = "https://lobster.mp";
const DEV_PUBLIC_ORIGIN = "https://dev.lobster.mp";

/** Chat/share links in email. Dev Worker runs write to api-dev DOs; the UI is on dev.lobster.mp. */
export function publicChatOrigin(requestOrigin?: string | null): string {
  if (typeof requestOrigin === "string" && requestOrigin.includes("api-dev.")) {
    return DEV_PUBLIC_ORIGIN;
  }
  return PUBLIC_ORIGIN;
}

export interface UserBotRunnerEnv extends MarketHoursEnv {
  SCHEMA_DB: D1Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CopilotAgent: DurableObjectNamespace<any>;
  COPILOT_MODEL?: string;
  OPEN_ROUTER_KEY?: string;
  EMAIL?: EmailSendBinding;
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
      audience?: "public" | "private";
      attach_portfolio?: boolean;
      portfolio_source?: "none" | "paper" | "schwab" | "all";
      portfolio_account_id?: string | null;
      portfolio_label?: string | null;
      publish_to_timeline?: boolean;
    };
    ownerUserId?: string;
  }) => Promise<{
    status: "completed" | "error" | "skipped" | "aborted";
    error?: string;
    model: string | null;
    messages: ShareTurn[];
  }>;
};

async function mintHumanShare(
  env: UserBotRunnerEnv,
  args: {
    userId: string;
    chatId: string;
    runId: string;
    model: string | null;
    messages: ShareTurn[];
    title?: string | null;
    listOnTimeline: boolean;
  },
): Promise<{ ok: true; share_id: string; listed: boolean } | { ok: false; error: string }> {
  try {
    const { messages, title, sourceSql } = capShareMessages(args.messages, args.title);
    if (!messages.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim())) {
      return { ok: false, error: "no assistant content to share" };
    }
    const moderationModel = env.OPEN_ROUTER_KEY?.trim() && env.COPILOT_MODEL?.trim()
      ? createChatModel(
        { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY, COPILOT_MODEL: env.COPILOT_MODEL },
        PUBLIC_ORIGIN,
      )
      : null;
    const moderation = args.listOnTimeline
      ? await moderateTimelineShare(messages, moderationModel)
      : { allow: false, reason: "unlisted", source: "skip" as const };
    const messagesJson = JSON.stringify(messages);
    if (utf8Bytes(messagesJson) + utf8Bytes(sourceSql ?? "") + 512 > SHARE_ROW_MAX_BYTES) {
      return { ok: false, error: "share payload too large" };
    }
    const shareId = base62Encode(crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES)));
    const now = Date.now();
    await env.SCHEMA_DB.prepare(
      `INSERT INTO shared_chats
         (share_id, chat_id, title, mode, model, messages, source_sql, created_ip, created_ua, created_at, updated_at, bot_handle, run_id)
       VALUES (?1, ?2, ?3, 'funded', ?4, ?5, ?6, 'user-bot', 'user-bot-runner', ?7, ?7, NULL, ?8)`,
    ).bind(shareId, args.chatId, title, args.model, messagesJson, sourceSql, now, args.runId).run();
    await recordShareOwner(env.SCHEMA_DB, shareId, args.userId);
    if (args.listOnTimeline && moderation.allow) {
      const excerpt = excerptFromMessages(messages, title);
      const flags = flagsFromMessages(messages);
      await env.SCHEMA_DB.prepare(
        `INSERT INTO timeline_posts
           (share_id, user_id, excerpt, has_sql, has_chart, published_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(shareId, args.userId, excerpt || null, flags.has_sql ? 1 : 0, flags.has_chart ? 1 : 0, now).run();
      return { ok: true, share_id: shareId, listed: true };
    }
    return { ok: true, share_id: shareId, listed: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runUserBotChat(
  env: UserBotRunnerEnv,
  bot: UserBot,
  opts?: { force?: boolean; waitUntil?: (p: Promise<unknown>) => void; publicOrigin?: string },
): Promise<
  | { ok: true; run: UserBotRun; chat_id: string; share_id: string | null }
  | { ok: false; error: string; run?: UserBotRun; chat_id?: string }
> {
  if (!bot.enabled) return { ok: false, error: "bot is disabled" };
  if (!env.OPEN_ROUTER_KEY?.trim() || !env.COPILOT_MODEL?.trim()) {
    return { ok: false, error: "Copilot is not configured" };
  }
  await expireStuckUserBotRuns(env.SCHEMA_DB);
  if (opts?.force) {
    await expireStaleActiveUserBotRun(env.SCHEMA_DB, bot.bot_id);
  }
  const active = await getActiveUserBotRun(env.SCHEMA_DB, bot.bot_id);
  if (active) {
    return {
      ok: false,
      error: "bot already has a run in progress",
      run: active,
      chat_id: active.chat_id,
    };
  }

  const chatId = crypto.randomUUID();
  const run = await createUserBotRun(env.SCHEMA_DB, bot, chatId, bot.prompt);
  await updateUserBotRun(env.SCHEMA_DB, run.run_id, { status: "running" });

  try {
    const agent = (env.CopilotAgent as DurableObjectNamespace).getByName(chatId) as unknown as HeadlessAgent;
    const turn = await agent.runHeadlessBotTurn({
      prompt: bot.prompt,
      ownerUserId: bot.user_id,
      bot: {
        handle: `acct-${bot.bot_id.slice(0, 8)}`,
        display_name: bot.name,
        persona: "Private account briefing",
        system_prompt_extra: "",
        audience: "private",
        attach_portfolio: bot.attach_portfolio,
        portfolio_source: bot.portfolio_source,
        portfolio_account_id: bot.portfolio_account_ids.length === 1
          ? bot.portfolio_account_ids[0]
          : bot.portfolio_account_ids.length > 1
            ? JSON.stringify(bot.portfolio_account_ids)
            : bot.portfolio_account_id,
        publish_to_timeline: bot.publish_to_timeline,
      },
    });
    if (turn.status !== "completed") {
      const error = turn.error || `turn ${turn.status}`;
      await updateUserBotRun(env.SCHEMA_DB, run.run_id, { status: "failed", error });
      return { ok: false, error, run: { ...run, status: "failed", error } };
    }

    let metaTitle: string | null = clipTitle(bot.name);
    try {
      const model = createChatModel(
        { OPEN_ROUTER_KEY: env.OPEN_ROUTER_KEY!, COPILOT_MODEL: env.COPILOT_MODEL! },
        PUBLIC_ORIGIN,
      );
      const meta = await enrichChatMeta(env, chatId, turn.messages, model);
      if (meta.title) metaTitle = meta.title;
    } catch (error) {
      console.warn("user-bot chat-meta enrich failed", error);
    }

    const handle = await getHandle(env.SCHEMA_DB, bot.user_id);
    const publish = accountBotPublishDecision({
      publish_to_timeline: bot.publish_to_timeline,
      hasHandle: Boolean(handle),
    });

    // Transcript backup for Chat restore. Must not fail the run or skip email.
    let shareId: string | null = null;
    let listed = false;
    try {
      const share = await mintHumanShare(env, {
        userId: bot.user_id,
        chatId,
        runId: run.run_id,
        model: turn.model,
        messages: turn.messages,
        title: metaTitle,
        listOnTimeline: publish.action === "publish",
      });
      if (share.ok) {
        shareId = share.share_id;
        listed = share.listed;
      } else {
        console.warn("user-bot transcript backup failed", share.error);
      }
    } catch (error) {
      console.warn("user-bot transcript backup failed", error);
    }

    const status = listed ? "shared" : "completed";
    const updated = await updateUserBotRun(env.SCHEMA_DB, run.run_id, {
      status,
      share_id: shareId,
    });

    if (bot.email_alerts) {
      const to = await getUserEmail(env.SCHEMA_DB, bot.user_id);
      if (to) {
        const site = publicChatOrigin(opts?.publicOrigin);
        const send = sendUserBotAlert(env.EMAIL, to, {
          botName: bot.name,
          title: metaTitle,
          briefing: assistantBriefingFromTurns(turn.messages),
          chatUrl: `${site}/chat/${chatId}`,
          shareUrl: shareId ? `${site}/share/${shareId}` : null,
        }).catch((error) => {
          console.warn("user-bot email failed", error);
          return { ok: false as const, error: String(error) };
        });
        // Await the send so isolate teardown cannot skip mail. waitUntil is
        // extra coverage if the Worker returns before SMTP finishes.
        if (opts?.waitUntil) opts.waitUntil(send);
        await send;
      }
    }

    // Claim after the turn so the chat does not appear in history while the
    // Durable Object is still generating — opening it mid-run aborts the RPC.
    try {
      const claimed = await claimChat(env.SCHEMA_DB, bot.user_id, chatId, metaTitle || bot.name);
      if (!claimed.ok) console.warn("user-bot claimChat failed", claimed.error);
    } catch (error) {
      console.warn("user-bot claimChat failed", error);
    }

    return {
      ok: true,
      run: updated ?? { ...run, status, share_id: shareId },
      chat_id: chatId,
      share_id: shareId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateUserBotRun(env.SCHEMA_DB, run.run_id, { status: "failed", error: message });
    return { ok: false, error: message, run };
  }
}

export async function runOneUserBot(
  env: UserBotRunnerEnv,
  bot: UserBot,
  opts?: { force?: boolean; waitUntil?: (p: Promise<unknown>) => void; publicOrigin?: string },
): Promise<
  | { ok: true; deferred?: false; run: UserBotRun; chat_id: string; share_id: string | null }
  | { ok: true; deferred: true; reason: string; next_run_at: number }
  | { ok: false; error: string; chat_id?: string }
> {
  const now = Date.now();
  // force=true is the HTTP "Run now" path — skip due/market gates. Cron omits force.
  if (!opts?.force) {
    const decision = scheduleRunDecision(bot, now, env);
    if (decision.action === "skip") return { ok: false, error: decision.reason };
    if (decision.action === "defer") {
      await deferUserBot(env.SCHEMA_DB, bot.bot_id, decision.next_run_at, now);
      return { ok: true, deferred: true, reason: decision.reason, next_run_at: decision.next_run_at };
    }
  }

  const result = await runUserBotChat(env, bot, {
    force: opts?.force,
    waitUntil: opts?.waitUntil,
    publicOrigin: opts?.publicOrigin,
  });
  if (!result.ok) {
    if (result.error !== "bot already has a run in progress") {
      await markUserBotFailure(env.SCHEMA_DB, bot.bot_id, result.error, now, env);
    }
    return { ok: false, error: result.error, chat_id: result.chat_id };
  }
  await markUserBotSuccess(env.SCHEMA_DB, bot.bot_id, result.run.run_id, now, env);
  return { ok: true, run: result.run, chat_id: result.chat_id, share_id: result.share_id };
}

export async function runDueUserBotSchedules(
  env: UserBotRunnerEnv,
  opts?: { waitUntil?: (p: Promise<unknown>) => void },
): Promise<{
  processed: number;
  ran: number;
  deferred: number;
  failed: number;
  results: Array<{ bot_id: string; status: string; detail?: string }>;
}> {
  await expireStuckUserBotRuns(env.SCHEMA_DB);
  const due = await listDueUserBots(env.SCHEMA_DB);
  const results: Array<{ bot_id: string; status: string; detail?: string }> = [];
  let ran = 0;
  let deferred = 0;
  let failed = 0;
  for (const scheduled of due) {
    try {
      const live = await getUserBot(env.SCHEMA_DB, scheduled.bot_id);
      if (!live || !live.enabled) continue;
      const outcome = await runOneUserBot(env, live, { waitUntil: opts?.waitUntil });
      if (outcome.ok && outcome.deferred) {
        deferred += 1;
        results.push({ bot_id: scheduled.bot_id, status: "deferred", detail: outcome.reason });
      } else if (outcome.ok) {
        ran += 1;
        results.push({ bot_id: scheduled.bot_id, status: outcome.run.status, detail: outcome.chat_id });
      } else {
        failed += 1;
        results.push({ bot_id: scheduled.bot_id, status: "failed", detail: outcome.error });
      }
    } catch (error) {
      failed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      await markUserBotFailure(env.SCHEMA_DB, scheduled.bot_id, detail, Date.now(), env);
      results.push({ bot_id: scheduled.bot_id, status: "failed", detail });
    }
  }
  return { processed: due.length, ran, deferred, failed, results };
}
