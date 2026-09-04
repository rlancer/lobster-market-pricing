/**
 * Cloudflare Email Service smoke-test helper for the Admin hub.
 * Sends from noreply@lobster.mp to a single recipient (session email or
 * ADMIN_TOKEN-supplied address).
 */

/** Product From for outbound mail (run alerts + admin smoke). */
export const LOBSTER_MAIL_FROM = {
  email: "noreply@lobster.mp",
  name: "The Lobster 😎",
} as const;

/** @deprecated Prefer LOBSTER_MAIL_FROM — kept as an alias for older imports. */
export const EMAIL_TEST_FROM = LOBSTER_MAIL_FROM;

export const EMAIL_TEST_SUBJECT = "The Lobster Email Service test";

export type EmailSendBinding = {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId: string }>;
};

export function escapeEmailHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function isLikelyEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("@") && !trimmed.includes(" ") && trimmed.length >= 3;
}

/** Prefer the signed-in admin email; allow ADMIN_TOKEN callers to pass `to`. */
export function resolveEmailTestRecipient(opts: {
  sessionEmail?: string | null;
  bodyTo?: unknown;
  tokenAuthorized: boolean;
}): { ok: true; to: string } | { ok: false; status: 400 | 401; error: string } {
  const session = typeof opts.sessionEmail === "string" ? opts.sessionEmail.trim() : "";
  if (session && isLikelyEmail(session)) return { ok: true, to: session };

  if (opts.tokenAuthorized && typeof opts.bodyTo === "string" && isLikelyEmail(opts.bodyTo)) {
    return { ok: true, to: opts.bodyTo.trim() };
  }

  if (!session && !opts.tokenAuthorized) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (opts.tokenAuthorized) {
    return {
      ok: false,
      status: 400,
      error: "to is required when using ADMIN_TOKEN (no signed-in session email)",
    };
  }
  return {
    ok: false,
    status: 401,
    error: "signed-in admin session required to receive the test email",
  };
}

export async function sendAdminEmailTest(
  email: EmailSendBinding,
  to: string,
): Promise<{ messageId: string }> {
  const safeTo = escapeEmailHtml(to);
  return email.send({
    to,
    from: { ...EMAIL_TEST_FROM },
    subject: EMAIL_TEST_SUBJECT,
    text: `This is a Cloudflare Email Service smoke test for ${to}.`,
    html: `<p>This is a Cloudflare Email Service smoke test for <strong>${safeTo}</strong>.</p>`,
  });
}
