/** How long we wait for CopilotAgent GET /get-messages before showing D1 backup. */
export const GET_MESSAGES_TIMEOUT_MS = 8_000;
/** Polls for PartySocket HTTP URL before the first get-messages fetch. */
export const AGENT_URL_WAIT_MS = 4_000;
const AGENT_URL_POLL_MS = 100;

export type ChatAccess = 'unknown' | 'ok' | 'unauthorized' | 'forbidden';

export function chatAccessFromStatus(status: number | null): ChatAccess {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'ok';
}

/**
 * Live Durable Object messages win. An empty/failed live fetch must not wipe a
 * D1 restore — that is how owned bot briefings stayed on "Opening chat…" when
 * get-messages hung behind chat recovery.
 */
export function pickChatHydrationSource(args: {
  liveCount: number;
  backupCount: number;
}): 'live' | 'backup' | 'empty' {
  if (args.liveCount > 0) return 'live';
  if (args.backupCount > 0) return 'backup';
  return 'empty';
}

export function getMessagesUrlFromAgentHttp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.replace(/^ws/i, 'http'));
    url.pathname = url.pathname.replace(/\/$/, '') + '/get-messages';
    return url.toString();
  } catch {
    return null;
  }
}

export function parseGetMessagesPayload(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function waitForAgentHttpUrl(
  getHttpUrl: () => string | undefined,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? AGENT_URL_WAIT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return null;
    const raw = getHttpUrl()?.trim() ?? '';
    if (raw) return raw;
    await new Promise((resolve) => setTimeout(resolve, AGENT_URL_POLL_MS));
  }
  return getHttpUrl()?.trim() || null;
}
