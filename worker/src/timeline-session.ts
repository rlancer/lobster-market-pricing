/**
 * Precomputed homepage Session card.
 *
 * The card used to fan out three live reads (lake tape, econ calendar,
 * latest @nowlobster share) on every `/` load. Those round trips are the
 * reason the homepage felt slow — lake highlights are 1–6s uncached.
 *
 * Snapshot lives in D1 `schema_cache` (same serve-stale pattern as
 * `/api/tables`): cron pre-warms every 5 minutes, GET serves the row
 * immediately and refreshes in the background when stale. Users never
 * wait on R2 SQL after the first fill.
 */
import { isDeskStubText } from "./chat-desk";
import { isPlanningOnlyTakeaway } from "./share-turns";
import {
  loadMarketHighlights,
  type TimelineLakeQuery,
  type TimelineRailHighlight,
} from "./timeline-rail";

export const DESK_HANDLE = "nowlobster";
export const SESSION_CACHE_KEY = "homepage_session_v2";
export const SESSION_TTL_MS = 5 * 60 * 1000;
export const SESSION_CALENDAR_DAYS = 14;
export const TAKEAWAY_MAX_CHARS = 280;
export const UPCOMING_EVENT_LIMIT = 2;

const ET = "America/New_York";

const SHORT_TITLES: ReadonlyArray<{ match: RegExp; short: string }> = [
  { match: /consumer price index|\bcpi\b/i, short: "CPI" },
  { match: /producer price index|\bppi\b/i, short: "PPI" },
  { match: /employment situation|nonfarm|payrolls?|\bnfp\b|\bjobs\b/i, short: "Jobs" },
  { match: /personal income and outlays|\bpce\b/i, short: "PCE" },
  { match: /gross domestic product|\bgdp\b/i, short: "GDP" },
  { match: /surveys of consumers|michigan/i, short: "Michigan" },
  { match: /beige/i, short: "Beige Book" },
  { match: /\bfomc\b|federal open market/i, short: "FOMC" },
];

export interface CalendarItem {
  date: string;
  title: string;
  kind: "macro" | "fed";
  time?: string;
}

export interface DeskTakeaway {
  handle: string;
  shareId: string;
  url: string;
  publishedAt: number;
  text: string;
}

export interface UpcomingEvent extends CalendarItem {
  shortTitle: string;
  when: string;
}

export interface HomepageSessionCache {
  tape: TimelineRailHighlight[];
  events: CalendarItem[];
  takeaway: DeskTakeaway | null;
  computed_at: number;
}

export interface HomepageSession {
  tape: TimelineRailHighlight[];
  events: UpcomingEvent[];
  takeaway: DeskTakeaway | null;
  ask_prompt: string;
  fetched_at: string;
}

export interface HomepageSessionEnv {
  SCHEMA_DB: D1Database;
}

export interface HomepageSessionDeps {
  env: HomepageSessionEnv;
  queryLake?: TimelineLakeQuery;
  loadCalendar: (days: number) => Promise<{ items: CalendarItem[] }>;
  now?: number;
  ctx?: Pick<ExecutionContext, "waitUntil">;
}

let sessionRefreshRunning = false;

export function pickTape(highlights: TimelineRailHighlight[]): TimelineRailHighlight[] {
  return highlights.filter((item) => item.spot != null || item.change_1d_pct != null);
}

export function etDateKey(nowMs: number): string {
  const parts = etParts(nowMs);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function shortEventTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "Event";
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
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix} ET`;
}

export function formatEventWhen(event: CalendarItem, nowMs: number): string {
  const today = etDateKey(nowMs);
  const clock = formatEventTime(event.time);
  let day: string;
  if (event.date === today) day = "today";
  else if (event.date === addCalendarDays(today, 1)) day = "tomorrow";
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
  items: CalendarItem[],
  nowMs: number,
  limit = UPCOMING_EVENT_LIMIT,
): UpcomingEvent[] {
  const today = etDateKey(nowMs);
  return items
    .filter((item) => item.date >= today && item.title.trim())
    .sort((a, b) => a.date.localeCompare(b.date) || (a.title < b.title ? -1 : 1))
    .slice(0, Math.max(1, Math.min(6, limit)))
    .map((item) => ({
      ...item,
      title: item.title.trim(),
      shortTitle: shortEventTitle(item.title),
      when: formatEventWhen(item, nowMs),
    }));
}

export function plainTakeaway(raw: string, maxChars = TAKEAWAY_MAX_CHARS): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (isScheduledDeskPrompt(text)) return "";
  if (text.startsWith("{") || text.startsWith("[")) return "";
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars + 1);
  const boundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  const cut = boundary >= maxChars * 0.5 ? window.slice(0, boundary + 1) : window.slice(0, maxChars);
  return cut.trimEnd();
}

export function isScheduledDeskPrompt(text: string): boolean {
  return /hourly market overview/i.test(text) || /lead with spx\/qqq/i.test(text);
}

export function deskTakeawayFromShare(row: {
  handle?: string | null;
  share_id: string;
  published_at: number;
  messages: unknown;
}): DeskTakeaway | null {
  if ((row.handle ?? "").trim().toLowerCase() !== DESK_HANDLE) return null;
  const text = plainTakeaway(deskSourceText(row.messages));
  if (text.length < 40) return null;
  return {
    handle: DESK_HANDLE,
    shareId: row.share_id,
    url: `/share/${row.share_id}`,
    publishedAt: row.published_at,
    text,
  };
}

export function tapeAskPrompt(
  highlights: TimelineRailHighlight[],
  events: UpcomingEvent[],
): string {
  const todayEvent = events.find((event) => event.when.startsWith("today"));
  if (todayEvent) {
    return `What's the tape into ${todayEvent.shortTitle}? Lead with SPX/QQQ/IWM and the front two VX months and whether ${todayEvent.shortTitle} is already in the options.`;
  }
  const movers = [...highlights]
    .filter((item) => item.change_1d_pct != null && Math.abs(item.change_1d_pct) >= 1)
    .sort((a, b) => Math.abs(b.change_1d_pct ?? 0) - Math.abs(a.change_1d_pct ?? 0));
  const lead = movers[0];
  if (lead) {
    return `What's driving ${lead.ticker} today? Tie it to SPX/QQQ/IWM posture and the options tape.`;
  }
  return "What's happening in the market right now? Lead with SPX/QQQ/IWM and the front two VX months, then the unusual options flow that explains it.";
}

export function presentHomepageSession(
  cached: HomepageSessionCache,
  nowMs: number,
): HomepageSession {
  const tape = pickTape(cached.tape);
  const events = pickUpcomingEvents(cached.events, nowMs);
  return {
    tape,
    events,
    takeaway: cached.takeaway,
    ask_prompt: tapeAskPrompt(tape, events),
    fetched_at: new Date(cached.computed_at).toISOString(),
  };
}

export async function computeHomepageSession(
  deps: HomepageSessionDeps,
): Promise<HomepageSessionCache> {
  const now = deps.now ?? Date.now();
  const [tapeResult, calendar, takeaway] = await Promise.all([
    loadMarketHighlights(
      { env: { SCHEMA_DB: deps.env.SCHEMA_DB }, queryLake: deps.queryLake },
      now,
    ).catch((): { items: TimelineRailHighlight[] } => ({ items: [] })),
    deps.loadCalendar(SESSION_CALENDAR_DAYS).catch((): { items: CalendarItem[] } => ({ items: [] })),
    loadDeskTakeaway(deps.env.SCHEMA_DB, now).catch(() => null),
  ]);
  return {
    tape: pickTape(tapeResult.items),
    events: (calendar.items ?? []).map((item) => ({
      date: item.date,
      title: item.title,
      kind: item.kind === "fed" ? "fed" : "macro",
      ...(item.time ? { time: item.time } : {}),
    })),
    takeaway,
    computed_at: now,
  };
}

export async function refreshHomepageSession(deps: HomepageSessionDeps): Promise<HomepageSessionCache> {
  if (sessionRefreshRunning) {
    const row = await readSessionRow(deps.env.SCHEMA_DB);
    if (row) return JSON.parse(row.payload) as HomepageSessionCache;
  }
  sessionRefreshRunning = true;
  try {
    const computed = await computeHomepageSession(deps);
    await writeSessionRow(deps.env.SCHEMA_DB, computed);
    return computed;
  } finally {
    sessionRefreshRunning = false;
  }
}

/** Mark the snapshot stale so the next GET refreshes in the background. */
export async function expireHomepageSession(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      "UPDATE schema_cache SET expires_at = 0 WHERE key = ?1",
    ).bind(SESSION_CACHE_KEY).run();
  } catch (error) {
    console.error("homepage session expire failed", error);
  }
}

/**
 * Serve the card. Fresh D1 rows return immediately; stale rows still return
 * immediately while waitUntil recomputes; only an empty cache computes inline.
 */
export async function serveHomepageSession(deps: HomepageSessionDeps): Promise<HomepageSession> {
  const now = deps.now ?? Date.now();
  const row = await readSessionRow(deps.env.SCHEMA_DB);
  if (row) {
    const cached = JSON.parse(row.payload) as HomepageSessionCache;
    if (now >= row.expires_at) {
      deps.ctx?.waitUntil(refreshHomepageSession(deps).then(() => undefined));
    }
    return presentHomepageSession(cached, now);
  }
  const computed = await refreshHomepageSession(deps);
  return presentHomepageSession(computed, now);
}

export async function loadDeskTakeaway(db: D1Database, now: number): Promise<DeskTakeaway | null> {
  const rows = await db.prepare(
    `SELECT s.share_id AS share_id, s.messages AS messages, s.created_at AS published_at, b.handle AS handle
     FROM shared_chats s
     JOIN bot_profiles b ON b.handle = s.bot_handle AND b.enabled = 1
     WHERE s.bot_handle = ?1
       AND (s.expires_at IS NULL OR s.expires_at > ?2)
     ORDER BY s.created_at DESC
     LIMIT 8`,
  ).bind(DESK_HANDLE, now).all<{
    share_id: string;
    messages: string | null;
    published_at: number;
    handle: string;
  }>();
  for (const row of rows.results ?? []) {
    let messages: unknown = row.messages;
    if (typeof messages === "string") {
      try { messages = JSON.parse(messages); } catch { messages = []; }
    }
    const takeaway = deskTakeawayFromShare({
      handle: row.handle,
      share_id: row.share_id,
      published_at: row.published_at,
      messages,
    });
    if (takeaway) return takeaway;
  }
  return null;
}

async function readSessionRow(db: D1Database): Promise<{ payload: string; expires_at: number } | null> {
  try {
    return (await db.prepare(
      "SELECT payload, expires_at FROM schema_cache WHERE key = ?1",
    ).bind(SESSION_CACHE_KEY).first<{ payload: string; expires_at: number }>()) ?? null;
  } catch (error) {
    console.error("homepage session cache read failed", error);
    return null;
  }
}

async function writeSessionRow(db: D1Database, snapshot: HomepageSessionCache): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO schema_cache (key, payload, expires_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at",
    ).bind(SESSION_CACHE_KEY, JSON.stringify(snapshot), snapshot.computed_at + SESSION_TTL_MS).run();
  } catch (error) {
    console.error("homepage session cache write failed", error);
  }
}

function deskSourceText(messages: unknown): string {
  const rows = Array.isArray(messages) ? messages : [];
  const assistants = rows.filter((row) => {
    return Boolean(row && typeof row === "object" && (row as { role?: string }).role === "assistant");
  }) as Array<{ content?: string; desk?: { overview?: string } }>;
  const last = assistants.at(-1);
  const overview = last?.desk?.overview?.trim();
  if (
    overview
    && overview.length >= 40
    && !isScheduledDeskPrompt(overview)
    && !isDeskStubText(overview)
  ) {
    return overview;
  }
  const content = last?.content?.trim();
  if (content && !isDeskStubText(content) && !isPlanningOnlyTakeaway(content)) return content;
  return "";
}

function etParts(nowMs: number): { year: string; month: string; day: string; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(nowMs))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return {
    year: bag.year ?? "1970",
    month: bag.month ?? "01",
    day: bag.day ?? "01",
    weekday: bag.weekday ?? "",
  };
}

function weekdayForDateKey(dateKey: string): string | null {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return null;
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
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  const ms = Date.UTC(year, month - 1, day, 16, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

/** Test hook — isolate-level refresh lock must not leak across cases. */
export function resetHomepageSessionRefresh(): void {
  sessionRefreshRunning = false;
}
