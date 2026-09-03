/**
 * Email alerts for private account-bot runs.
 *
 * Sends from noreply@lobster.mp via Cloudflare Email Service. Failure must
 * never fail the bot run — the chat already landed in the owner's history.
 */
import { EMAIL_TEST_FROM, escapeEmailHtml, isLikelyEmail, type EmailSendBinding } from "./admin-email-test";

export const USER_BOT_ALERT_EXCERPT_MAX = 800;

export function clipAlertExcerpt(text: string, max = USER_BOT_ALERT_EXCERPT_MAX): string {
  const normalized = text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function assistantExcerptFromTurns(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  for (const message of messages) {
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return clipAlertExcerpt(message.content);
    }
  }
  return "";
}

export function buildUserBotAlertEmail(args: {
  botName: string;
  excerpt: string;
  chatUrl: string;
  shareUrl?: string | null;
}): { subject: string; text: string; html: string } {
  const name = args.botName.trim() || "Your bot";
  const subject = `${name} finished a run`;
  const excerpt = args.excerpt.trim() || "The briefing is ready in Chat.";
  const link = args.shareUrl?.trim() || args.chatUrl;
  const text = [
    `${name} just finished a run.`,
    "",
    excerpt,
    "",
    `Open the briefing: ${link}`,
  ].join("\n");
  const html = [
    `<p><strong>${escapeEmailHtml(name)}</strong> just finished a run.</p>`,
    `<p>${escapeEmailHtml(excerpt).replace(/\n/g, "<br>")}</p>`,
    `<p><a href="${escapeEmailHtml(link)}">Open the briefing</a></p>`,
  ].join("");
  return { subject, text, html };
}

export async function sendUserBotAlert(
  email: EmailSendBinding | undefined,
  to: string,
  args: {
    botName: string;
    excerpt: string;
    chatUrl: string;
    shareUrl?: string | null;
  },
): Promise<{ ok: true; message_id: string } | { ok: false; error: string }> {
  if (!email) return { ok: false, error: "email is not configured" };
  const dest = to.trim();
  if (!isLikelyEmail(dest)) return { ok: false, error: "invalid recipient" };
  const built = buildUserBotAlertEmail(args);
  try {
    const result = await email.send({
      to: dest,
      from: { ...EMAIL_TEST_FROM },
      subject: built.subject,
      text: built.text,
      html: built.html,
    });
    return { ok: true, message_id: result.messageId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
