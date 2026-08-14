/** Active Copilot conversation UUID — sessionStorage plus `/chat/$chatId`. */

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIVE_CHAT_KEY = 'openinterest_copilot_chat_id';
export const CHATS_CHANGED_EVENT = 'lobster:chats-changed';

export function parseChatId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return CHAT_ID_RE.test(id) ? id : null;
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

export function notifyChatsChanged(): void {
  window.dispatchEvent(new Event(CHATS_CHANGED_EVENT));
}
