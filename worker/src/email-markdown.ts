/**
 * Markdown → email-safe HTML for transactional mail (account-bot alerts).
 *
 * Uses marked with GFM + soft line breaks. Raw HTML tokens are escaped so
 * model output cannot inject markup into the message body.
 */
import { Marked, type Tokens } from "marked";
import { escapeEmailHtml } from "./admin-email-test";

function sanitizeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Block javascript:/data:/vbscript: and other non-web schemes.
  if (!/^(https?:|mailto:|\/|#)/i.test(trimmed)) return null;
  return trimmed;
}

const emailMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeEmailHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const safe = sanitizeHref(href);
      const body = this.parser.parseInline(tokens);
      if (!safe) return body;
      const titleAttr =
        typeof title === "string" && title.trim()
          ? ` title="${escapeEmailHtml(title.trim())}"`
          : "";
      return `<a href="${escapeEmailHtml(safe)}"${titleAttr}>${body}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const safe = sanitizeHref(href);
      const alt = escapeEmailHtml(text || "");
      if (!safe) return alt;
      const titleAttr =
        typeof title === "string" && title.trim()
          ? ` title="${escapeEmailHtml(title.trim())}"`
          : "";
      return `<img src="${escapeEmailHtml(safe)}" alt="${alt}"${titleAttr}>`;
    },
  },
});

/** Convert briefing markdown into HTML suitable for a multipart email body. */
export function markdownToEmailHtml(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return "";
  const html = emailMarked.parse(trimmed, { async: false });
  return typeof html === "string" ? html.trim() : "";
}
