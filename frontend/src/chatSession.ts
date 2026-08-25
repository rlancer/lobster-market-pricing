/** Live Copilot conversation UUID — sessionStorage. Saved chats use `/chat/$chatId`; the live session is `/chat`. */

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIVE_CHAT_KEY = 'openinterest_copilot_chat_id';
export const LIVE_CHAT_KEY = 'openinterest_copilot_live_chat_id';
export const PENDING_PROMPT_KEY = 'openinterest_copilot_pending_prompt';
export const FORK_CONTEXT_KEY = 'openinterest_copilot_fork_context';
export const PENDING_FORK_KEY = 'openinterest_copilot_pending_fork';
export const BOT_HANDLE_KEY = 'openinterest_copilot_bot_handle';
export const BOT_RUN_KEY = 'openinterest_copilot_bot_run_id';
export const CHATS_CHANGED_EVENT = 'lobster:chats-changed';
/** Fired after `requestNewChat` so a mounted /chat session can remount onto the new id. */
export const NEW_CHAT_EVENT = 'lobster:new-chat';

export function parseChatId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return CHAT_ID_RE.test(id) ? id : null;
}

/** Newest activity first. Ties break on created_at, then chat_id. */
export function compareUserChats(
  a: { chat_id: string; created_at: number; updated_at: number },
  b: { chat_id: string; created_at: number; updated_at: number },
): number {
  if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
  if (b.created_at !== a.created_at) return b.created_at - a.created_at;
  if (a.chat_id < b.chat_id) return 1;
  if (a.chat_id > b.chat_id) return -1;
  return 0;
}

export function sortUserChats<T extends { chat_id: string; created_at: number; updated_at: number }>(items: T[]): T[] {
  return [...items].sort(compareUserChats);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Relative-time label for left-nav chat history, keyed off `updated_at`
 * (ms epoch). Buckets match common chat UIs: Today → Yesterday → Last 7
 * days → Last 30 days → calendar month (with year when not current).
 */
export function chatHistoryTimeLabel(updatedAtMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(updatedAtMs)) return 'Older';

  const todayStart = startOfLocalDay(nowMs);
  const yesterdayStart = todayStart - DAY_MS;
  // Inclusive 7 / 30 calendar-day windows measured from start of today.
  const last7Start = todayStart - 6 * DAY_MS;
  const last30Start = todayStart - 29 * DAY_MS;

  if (updatedAtMs >= todayStart) return 'Today';
  if (updatedAtMs >= yesterdayStart) return 'Yesterday';
  if (updatedAtMs >= last7Start) return 'Last 7 days';
  if (updatedAtMs >= last30Start) return 'Last 30 days';

  const when = new Date(updatedAtMs);
  const now = new Date(nowMs);
  if (when.getFullYear() === now.getFullYear()) {
    return when.toLocaleString(undefined, { month: 'long' });
  }
  return when.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

export type ChatHistoryTimeGroup<T> = {
  label: string;
  items: T[];
};

/**
 * Group already-sorted chats into relative-time buckets. Preserves input
 * order within each bucket and emits buckets in first-seen (newest) order.
 */
export function groupUserChatsByRelativeTime<T extends { updated_at: number }>(
  items: T[],
  nowMs: number = Date.now(),
): ChatHistoryTimeGroup<T>[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];

  for (const item of items) {
    const label = chatHistoryTimeLabel(item.updated_at, nowMs);
    const existing = groups.get(label);
    if (existing) {
      existing.push(item);
      continue;
    }
    groups.set(label, [item]);
    order.push(label);
  }

  return order.map((label) => ({ label, items: groups.get(label) ?? [] }));
}

export function chatPath(chatId: string): string {
  return `/chat/${chatId}`;
}

export function rememberChatId(chatId: string): string {
  sessionStorage.setItem(ACTIVE_CHAT_KEY, chatId);
  return chatId;
}

export function readStoredChatId(): string | null {
  try {
    return parseChatId(sessionStorage.getItem(ACTIVE_CHAT_KEY));
  } catch {
    return null;
  }
}

function readLiveChatId(): string | null {
  try {
    return parseChatId(sessionStorage.getItem(LIVE_CHAT_KEY));
  } catch {
    return null;
  }
}

/** Live `/chat` conversation — not overwritten when opening a saved `/chat/{id}`. */
export function ensureLiveChatId(): string {
  const id = readLiveChatId() ?? crypto.randomUUID();
  sessionStorage.setItem(LIVE_CHAT_KEY, id);
  return rememberChatId(id);
}

/** Replace the live `/chat` conversation with a fresh UUID. */
export function startNewChatId(): string {
  const id = crypto.randomUUID();
  sessionStorage.setItem(LIVE_CHAT_KEY, id);
  return rememberChatId(id);
}

/**
 * Start a fresh live chat and notify any mounted Chat session. Use this from
 * chrome outside AiChat (mobile top bar) so /chat remounts onto the new id.
 */
export function requestNewChat(): string {
  clearBotSession();
  const id = startNewChatId();
  try {
    window.dispatchEvent(new Event(NEW_CHAT_EVENT));
  } catch {
    /* ignore — non-DOM environments */
  }
  return id;
}

/** Stash a prompt for `/chat` to auto-send once the agent socket is ready. */
export function stashPendingPrompt(text: string): void {
  const prompt = text.trim();
  if (!prompt) return;
  sessionStorage.setItem(PENDING_PROMPT_KEY, prompt);
}

/** Peek at a pending timeline/home prompt without clearing it. */
export function peekPendingPrompt(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PROMPT_KEY);
    if (raw == null) return null;
    const prompt = raw.trim();
    return prompt || null;
  } catch {
    return null;
  }
}

/** Clear a pending timeline/home prompt after it has been handed to the agent. */
export function clearPendingPrompt(): void {
  try {
    sessionStorage.removeItem(PENDING_PROMPT_KEY);
  } catch {
    /* ignore */
  }
}

export type ForkContext = {
  parent_share_id: string;
  parent_handle: string | null;
  parent_name: string | null;
  fork_seed_count: number;
};

/** Banner context after forking a timeline/share conversation. */
export function stashForkContext(ctx: ForkContext): void {
  try {
    sessionStorage.setItem(FORK_CONTEXT_KEY, JSON.stringify(ctx));
  } catch {
    /* ignore */
  }
}

export function takeForkContext(): ForkContext | null {
  try {
    const raw = sessionStorage.getItem(FORK_CONTEXT_KEY);
    sessionStorage.removeItem(FORK_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ForkContext>;
    if (typeof parsed.parent_share_id !== 'string' || !parsed.parent_share_id.trim()) return null;
    return {
      parent_share_id: parsed.parent_share_id.trim(),
      parent_handle: typeof parsed.parent_handle === 'string' ? parsed.parent_handle : null,
      parent_name: typeof parsed.parent_name === 'string' ? parsed.parent_name : null,
      fork_seed_count: typeof parsed.fork_seed_count === 'number' ? parsed.fork_seed_count : 0,
    };
  } catch {
    return null;
  }
}

export type PendingFork = {
  share_id: string;
  question: string;
};

/**
 * Stash a follow-up across Google sign-in (OAuth leaves the page). Cleared when
 * the fork API succeeds or the draft is abandoned.
 */
export function stashPendingFork(shareId: string, question: string): void {
  const share_id = shareId.trim();
  const q = question.trim();
  if (!share_id || !q) return;
  try {
    sessionStorage.setItem(PENDING_FORK_KEY, JSON.stringify({ share_id, question: q }));
  } catch {
    /* ignore */
  }
}

export function peekPendingFork(): PendingFork | null {
  try {
    const raw = sessionStorage.getItem(PENDING_FORK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingFork>;
    if (typeof parsed.share_id !== 'string' || typeof parsed.question !== 'string') return null;
    const share_id = parsed.share_id.trim();
    const question = parsed.question.trim();
    if (!share_id || !question) return null;
    return { share_id, question };
  } catch {
    return null;
  }
}

export function clearPendingFork(): void {
  try {
    sessionStorage.removeItem(PENDING_FORK_KEY);
  } catch {
    /* ignore */
  }
}

/** Bind the next /chat session to a bot persona (admin generate flow). */
export function stashBotSession(handle: string, runId?: string | null): void {
  const clean = handle.trim().toLowerCase();
  if (!clean) return;
  sessionStorage.setItem(BOT_HANDLE_KEY, clean);
  if (runId) sessionStorage.setItem(BOT_RUN_KEY, runId);
  else sessionStorage.removeItem(BOT_RUN_KEY);
}

export function peekBotHandle(): string | null {
  try {
    const raw = sessionStorage.getItem(BOT_HANDLE_KEY);
    return raw?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

export function peekBotRunId(): string | null {
  try {
    return sessionStorage.getItem(BOT_RUN_KEY);
  } catch {
    return null;
  }
}

export function clearBotSession(): void {
  try {
    sessionStorage.removeItem(BOT_HANDLE_KEY);
    sessionStorage.removeItem(BOT_RUN_KEY);
  } catch {
    /* ignore */
  }
}

export function notifyChatsChanged(): void {
  window.dispatchEvent(new Event(CHATS_CHANGED_EVENT));
}
