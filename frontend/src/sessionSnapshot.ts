/**
 * Homepage session card — tape, next macro print, latest @nowlobster takeaway.
 * Pure helpers so the card can stay a 5-second scan without extra Worker surface.
 */
import type { EconCalendarEvent, TimelinePost, TimelineRailHighlight } from './api';

export const DESK_HANDLE = 'nowlobster';
export const TAKEAWAY_MAX_CHARS = 280;
export const UPCOMING_EVENT_LIMIT = 2;

const ET = 'America/New_York';

const SHORT_TITLES: ReadonlyArray<{ match: RegExp; short: string }> = [
  { match: /consumer price index|\bcpi\b/i, short: 'CPI' },
  { match: /producer price index|\bppi\b/i, short: 'PPI' },
  { match: /employment situation|nonfarm|payrolls?|\bnfp\b|\bjobs\b/i, short: 'Jobs' },
  { match: /personal income and outlays|\bpce\b/i, short: 'PCE' },
  { match: /gross domestic product|\bgdp\b/i, short: 'GDP' },
  { match: /surveys of consumers|michigan/i, short: 'Michigan' },
  { match: /beige/i, short: 'Beige Book' },
  { match: /\bfomc\b|federal open market/i, short: 'FOMC' },
];

export interface UpcomingEvent {
  date: string;
  title: string;
  shortTitle: string;
  kind: EconCalendarEvent['kind'];
  time?: string;
  when: string;
}

export interface DeskTakeaway {
  handle: string;
  shareId: string;
  url: string;
  publishedAt: number;
  text: string;
}

export function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function fmtSpot(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function changeDirection(value: number | null | undefined): 'up' | 'down' | 'flat' {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** Drop watchlist rows with no printable tape. */
export function pickTape(highlights: TimelineRailHighlight[]): TimelineRailHighlight[] {
  return highlights.filter((item) => item.spot != null || item.change_1d_pct != null);
}

export function etDateKey(nowMs: number): string {
  const parts = etParts(nowMs);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function shortEventTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return 'Event';
  for (const row of SHORT_TITLES) {
    if (row.match.test(trimmed)) return row.short;
  }
  return trimmed;
}

export function formatEventTime(time: string | undefined): string | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2];
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix} ET`;
}

export function formatEventWhen(event: EconCalendarEvent, nowMs: number): string {
  const today = etDateKey(nowMs);
  const clock = formatEventTime(event.time);
  let day: string;
  if (event.date === today) day = 'today';
  else if (event.date === addCalendarDays(today, 1)) day = 'tomorrow';
  else {
    const weekday = weekdayForDateKey(event.date);
    const daysOut = calendarDaysBetween(today, event.date);
    day = weekday && daysOut != null && daysOut >= 0 && daysOut < 7
      ? weekday
      : formatMonthDay(event.date);
  }
  return clock ? `${day} ${clock}` : day;
}

export function pickUpcomingEvents(
  items: EconCalendarEvent[],
  nowMs: number,
  limit = UPCOMING_EVENT_LIMIT,
): UpcomingEvent[] {
  const today = etDateKey(nowMs);
  const upcoming = items
    .filter((item) => item.date >= today && item.title.trim())
    .sort((a, b) => a.date.localeCompare(b.date) || (a.title < b.title ? -1 : 1))
    .slice(0, Math.max(1, Math.min(6, limit)));
  return upcoming.map((item) => ({
    date: item.date,
    title: item.title.trim(),
    shortTitle: shortEventTitle(item.title),
    kind: item.kind,
    time: item.time,
    when: formatEventWhen(item, nowMs),
  }));
}

export function plainTakeaway(raw: string, maxChars = TAKEAWAY_MAX_CHARS): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (isScheduledDeskPrompt(text)) return '';
  if (text.startsWith('{') || text.startsWith('[')) return '';
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars + 1);
  const boundary = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  const cut = boundary >= maxChars * 0.5 ? window.slice(0, boundary + 1) : window.slice(0, maxChars);
  return cut.trimEnd();
}

export function isScheduledDeskPrompt(text: string): boolean {
  return /hourly market overview/i.test(text) || /lead with spx\/qqq/i.test(text);
}

export function deskTakeaway(post: TimelinePost | null | undefined): DeskTakeaway | null {
  if (!post) return null;
  if (post.handle.trim().toLowerCase() !== DESK_HANDLE) return null;
  const text = plainTakeaway(deskSourceText(post));
  if (text.length < 40) return null;
  return {
    handle: DESK_HANDLE,
    shareId: post.share_id,
    url: post.url || `/share/${post.share_id}`,
    publishedAt: post.published_at,
    text,
  };
}

export function tapeAskPrompt(
  highlights: TimelineRailHighlight[],
  events: UpcomingEvent[],
): string {
  const todayEvent = events.find((event) => event.when.startsWith('today'));
  if (todayEvent) {
    return `What's the tape into ${todayEvent.shortTitle}? Lead with SPX/QQQ/IWM/VIX and whether ${todayEvent.shortTitle} is already in the options.`;
  }
  const movers = [...highlights]
    .filter((item) => item.change_1d_pct != null && Math.abs(item.change_1d_pct) >= 1)
    .sort((a, b) => Math.abs(b.change_1d_pct ?? 0) - Math.abs(a.change_1d_pct ?? 0));
  const lead = movers[0];
  if (lead) {
    return `What's driving ${lead.ticker} today? Tie it to SPX/QQQ/IWM posture and the options tape.`;
  }
  return "What's happening in the market right now? Lead with SPX/QQQ/IWM/VIX, then the unusual options flow that explains it.";
}

export function sessionHasContent(
  tape: TimelineRailHighlight[],
  events: UpcomingEvent[],
  takeaway: DeskTakeaway | null,
): boolean {
  return tape.length > 0 || events.length > 0 || takeaway != null;
}

function deskSourceText(post: TimelinePost): string {
  const assistants = (post.messages ?? []).filter((message) => message.role === 'assistant');
  const last = assistants.at(-1);
  const overview = last?.desk?.overview?.trim();
  if (overview && overview.length >= 40 && !isScheduledDeskPrompt(overview)) return overview;
  const content = last?.content?.trim();
  if (content) return content;
  return post.excerpt ?? '';
}

function etParts(nowMs: number): { year: string; month: string; day: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(nowMs))) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  return {
    year: bag.year ?? '1970',
    month: bag.month ?? '01',
    day: bag.day ?? '01',
    weekday: bag.weekday ?? '',
  };
}

function weekdayForDateKey(dateKey: string): string | null {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return null;
  // Noon UTC is the same calendar date in ET for every US session date.
  const ms = Date.UTC(year, month - 1, day, 16, 0, 0);
  if (!Number.isFinite(ms)) return null;
  return etParts(ms).weekday || null;
}

function calendarDaysBetween(fromKey: string, toKey: string): number | null {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

function formatMonthDay(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  const ms = Date.UTC(year, month - 1, day, 16, 0, 0);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}
