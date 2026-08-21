/**
 * Canned Copilot reply voices. IDs / caps must match worker/src/reply-style.ts.
 * Prompt copy lives only on the Worker so the client cannot inflate context.
 */
export const REPLY_STYLE_IDS = ['desk', 'fund', 'learner'] as const;
export type ReplyStyleId = (typeof REPLY_STYLE_IDS)[number];

export const DEFAULT_REPLY_STYLE: ReplyStyleId = 'desk';
export const REPLY_NOTE_MAX = 240;

export interface ReplyStyleOption {
  id: ReplyStyleId;
  label: string;
  hint: string;
}

export const REPLY_STYLE_OPTIONS: ReplyStyleOption[] = [
  { id: 'desk', label: 'Desk trader', hint: 'Direct, numbers-first' },
  { id: 'fund', label: 'Hedge fund', hint: 'Institutional, book-aware' },
  { id: 'learner', label: 'New to trading', hint: 'Teach jargon as you go' },
];

export interface ReplyPref {
  style: ReplyStyleId;
  note: string;
}

export const REPLY_STYLE_STORAGE_KEY = 'lobster.reply-style';
export const REPLY_STYLE_EVENT = 'lobster:reply-style';

const STYLE_SET = new Set<string>(REPLY_STYLE_IDS);

export function isReplyStyleId(value: unknown): value is ReplyStyleId {
  return typeof value === 'string' && STYLE_SET.has(value);
}

export function parseReplyPref(raw: unknown): ReplyPref {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const style = isReplyStyleId(rec.style) ? rec.style : DEFAULT_REPLY_STYLE;
  const note = typeof rec.note === 'string'
    ? rec.note.trim().replace(/\s+/g, ' ').slice(0, REPLY_NOTE_MAX)
    : '';
  return { style, note };
}

export function loadReplyPref(): ReplyPref {
  if (typeof localStorage === 'undefined') return { style: DEFAULT_REPLY_STYLE, note: '' };
  try {
    return parseReplyPref(JSON.parse(localStorage.getItem(REPLY_STYLE_STORAGE_KEY) ?? 'null'));
  } catch {
    return { style: DEFAULT_REPLY_STYLE, note: '' };
  }
}

export function saveReplyPref(pref: ReplyPref): ReplyPref {
  const next = parseReplyPref(pref);
  try {
    localStorage.setItem(REPLY_STYLE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — in-memory still works for this tab.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REPLY_STYLE_EVENT, { detail: next }));
  }
  return next;
}
