/**
 * Email alerts for private account-bot runs.
 *
 * Sends from noreply@lobster.mp via Cloudflare Email Service. Failure must
 * never fail the bot run — the chat already landed in the owner's history.
 */
import {
  LOBSTER_MAIL_FROM,
  escapeEmailHtml,
  isLikelyEmail,
  type EmailSendBinding,
} from "./admin-email-test";
import { markdownToEmailHtml } from "./email-markdown";

/** Display From for run alerts — sunglasses nod to the brand mark. */
export const USER_BOT_ALERT_FROM = LOBSTER_MAIL_FROM;

/** Normalize whitespace for email bodies; do not truncate — send the full briefing. */
export function normalizeAlertBriefing(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function assistantBriefingFromTurns(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const rec = message as { role?: unknown; content?: unknown };
    if (rec.role === "assistant" && typeof rec.content === "string" && rec.content.trim()) {
      return normalizeAlertBriefing(rec.content);
    }
  }
  return "";
}

/** Owner-facing copy when the quality gate withholds a junk briefing from email. */
export const PRIVATE_BRIEFING_NOT_READY =
  "This run finished, but the briefing wasn't ready to send. Open Chat to see the transcript, or wait for the next run.";

/** Full briefing when the gate allows; a short notice when it rejects. */
export function briefingForUserBotAlert(allow: boolean, briefing: string): string {
  if (!allow) return PRIVATE_BRIEFING_NOT_READY;
  return normalizeAlertBriefing(briefing);
}

export function buildUserBotAlertEmail(args: {
  botName: string;
  /** Generated chat/share title — preferred email subject. */
  title?: string | null;
  briefing: string;
  chatUrl: string;
  shareUrl?: string | null;
}): { subject: string; text: string; html: string } {
  const name = args.botName.trim() || "Your bot";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const subject = title || `${name} finished a run`;
  const briefing = args.briefing.trim() || "The briefing is ready in Chat.";
  const link = args.shareUrl?.trim() || args.chatUrl;
  const text = [
    `${name} just finished a run.`,
    "",
    briefing,
    "",
    `Open the briefing: ${link}`,
  ].join("\n");
  const briefingHtml = markdownToEmailHtml(briefing) || `<p>${escapeEmailHtml(briefing)}</p>`;
  const html = [
    `<p><strong>${escapeEmailHtml(name)}</strong> just finished a run.</p>`,
    briefingHtml,
    `<p><a href="${escapeEmailHtml(link)}">Open the briefing</a></p>`,
  ].join("");
  return { subject, text, html };
}

export async function sendUserBotAlert(
  email: EmailSendBinding | undefined,
  to: string,
  args: {
    botName: string;
    title?: string | null;
    briefing: string;
    chatUrl: string;
    shareUrl?: string | null;
  },
): Promise<
  | { ok: true; message_id: string; subject: string }
  | { ok: false; error: string; subject?: string }
> {
  if (!email) return { ok: false, error: "email is not configured" };
  const dest = to.trim();
  if (!isLikelyEmail(dest)) return { ok: false, error: "invalid recipient" };
  const built = buildUserBotAlertEmail(args);
  const base = {
    to: dest,
    from: { ...USER_BOT_ALERT_FROM },
    subject: built.subject,
    text: built.text,
  };
  try {
    const result = await email.send({ ...base, html: built.html });
    return { ok: true, message_id: result.messageId, subject: built.subject };
  } catch (htmlError) {
    // Some alert bodies (GFM tables, long markdown HTML) can trip the send
    // path — fall back to text-only so the owner still gets the subject/link.
    try {
      const result = await email.send(base);
      console.warn("user-bot email html send failed; sent text-only", {
        error: htmlError instanceof Error ? htmlError.message : String(htmlError),
        subject: built.subject,
      });
      return { ok: true, message_id: result.messageId, subject: built.subject };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        subject: built.subject,
      };
    }
  }
}
