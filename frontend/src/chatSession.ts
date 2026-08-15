/** Active Copilot conversation UUID — sessionStorage plus `/chat/$chatId`. */

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIVE_CHAT_KEY = 'openinterest_copilot_chat_id';
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

export function ensureChatId(): string {
  return rememberChatId(readStoredChatId() ?? crypto.randomUUID());
}

/** Fresh conversation UUID — never reuse a history/session id. */
export function startNewChatId(): string {
  return rememberChatId(crypto.randomUUID());
}

export function notifyChatsChanged(): void {
  window.dispatchEvent(new Event(CHATS_CHANGED_EVENT));
}
