/** Live Copilot conversation UUID — sessionStorage. Saved chats use `/chat/$chatId`; the live session is `/chat`. */

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIVE_CHAT_KEY = 'openinterest_copilot_chat_id';
export const LIVE_CHAT_KEY = 'openinterest_copilot_live_chat_id';
export const CHATS_CHANGED_EVENT = 'lobster:chats-changed';

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

export function notifyChatsChanged(): void {
  window.dispatchEvent(new Event(CHATS_CHANGED_EVENT));
}
