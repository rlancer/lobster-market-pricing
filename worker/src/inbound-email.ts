/**
 * Inbound Email Routing for lobster.mp.
 *
 * Cloudflare Email Routing delivers matching addresses to this Worker's
 * `email()` handler. For now hello@lobster.mp is forwarded to the owner
 * inbox; unknown recipients are rejected.
 *
 * Destination addresses must be verified in Email Routing before
 * `message.forward()` succeeds (`wrangler email routing addresses create`).
 */

export const HELLO_INBOUND = "hello@lobster.mp" as const;
export const HELLO_FORWARD_TO = "robert.lancer@gmail.com" as const;

/** Map of accepted inbound addresses (lowercase) → verified forward targets. */
export const INBOUND_FORWARD_MAP: Readonly<Record<string, string>> = {
  [HELLO_INBOUND]: HELLO_FORWARD_TO,
};

export type InboundEmailMessage = {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
};

/** Normalize envelope RCPT TO to a bare lowercase address. */
export function normalizeInboundRecipient(to: string): string {
  const trimmed = to.trim().toLowerCase();
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : trimmed).trim();
  // Drop +subaddress for allowlist matching (hello+tag@ → hello@).
  const at = addr.lastIndexOf("@");
  if (at <= 0) return addr;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf("+");
  const baseLocal = plus >= 0 ? local.slice(0, plus) : local;
  return `${baseLocal}@${domain}`;
}

export function resolveInboundForward(to: string): string | null {
  const key = normalizeInboundRecipient(to);
  return INBOUND_FORWARD_MAP[key] ?? null;
}

/**
 * Route one inbound message: forward known addresses, reject the rest.
 * Returns a short outcome string for logging/tests.
 */
export async function handleInboundEmail(
  message: InboundEmailMessage,
): Promise<"forwarded" | "rejected"> {
  const dest = resolveInboundForward(message.to);
  if (!dest) {
    message.setReject("Address not accepted");
    return "rejected";
  }

  const headers = new Headers();
  headers.set("X-Original-Recipient", message.to);
  headers.set("X-Lobster-Inbound", "hello-forward");
  await message.forward(dest, headers);
  return "forwarded";
}
