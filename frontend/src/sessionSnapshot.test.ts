import assert from 'node:assert/strict';
import test from 'node:test';
import type { EconCalendarEvent, TimelinePost, TimelineRailHighlight } from './api.ts';
import {
  DESK_HANDLE,
  changeDirection,
  deskTakeaway,
  etDateKey,
  formatEventTime,
  formatEventWhen,
  fmtPct,
  pickTape,
  pickUpcomingEvents,
  plainTakeaway,
  sessionHasContent,
  shortEventTitle,
  tapeAskPrompt,
} from './sessionSnapshot.ts';

/** Thursday 2026-09-03 16:00 ET (20:00 UTC, still EDT). */
const THU_ET = Date.parse('2026-09-03T20:00:00.000Z');
/** Friday 03:00 UTC = Thursday 23:00 ET. */
const THU_LATE_ET = Date.parse('2026-09-04T03:00:00.000Z');

function post(overrides: Partial<TimelinePost> = {}): TimelinePost {
  return {
    share_id: 'ShareDeskNowlobster000000001',
    url: '/share/ShareDeskNowlobster000000001',
    title: 'Hourly market overview',
    excerpt: 'Hourly market overview: what\'s happening right now?',
    messages: [
      { role: 'user', content: 'Hourly market overview: what\'s happening right now? Lead with SPX/QQQ.' },
      {
        role: 'assistant',
        content: 'SPX holds the 6500 handle while QQQ lags. Unusual call buying in NVDA led the tape; risk stays defined until CPI.',
      },
    ],
    handle: DESK_HANDLE,
    name: 'Now Lobster',
    published_at: THU_ET,
    model: 'test-model',
    has_sql: true,
    has_chart: false,
    is_bot: true,
    ...overrides,
  };
}

test('fmtPct signs the move and blanks missing tape', () => {
  assert.equal(fmtPct(0.41), '+0.4%');
  assert.equal(fmtPct(-1.26), '-1.3%');
  assert.equal(fmtPct(0), '+0.0%');
  assert.equal(fmtPct(null), '—');
  assert.equal(changeDirection(1.2), 'up');
  assert.equal(changeDirection(-0.1), 'down');
  assert.equal(changeDirection(0), 'flat');
});

test('pickTape drops empty watchlist rows', () => {
  const rows: TimelineRailHighlight[] = [
    { ticker: 'SPY', name: 'S&P 500', spot: 500, change_1d_pct: 0.4 },
    { ticker: 'DIA', name: 'Dow Jones', spot: null, change_1d_pct: null },
    { ticker: '^VIX', name: 'VIX', spot: 16.2, change_1d_pct: -3.1 },
  ];
  assert.deepEqual(pickTape(rows).map((row) => row.ticker), ['SPY', '^VIX']);
});

test('etDateKey uses America/New_York, not UTC', () => {
  assert.equal(etDateKey(THU_ET), '2026-09-03');
  assert.equal(etDateKey(THU_LATE_ET), '2026-09-03');
});

test('shortEventTitle maps high-impact prints', () => {
  assert.equal(shortEventTitle('Consumer Price Index'), 'CPI');
  assert.equal(shortEventTitle('Employment Situation'), 'Jobs');
  assert.equal(shortEventTitle('FOMC Meeting'), 'FOMC');
  assert.equal(shortEventTitle('Beige Book'), 'Beige Book');
  assert.equal(shortEventTitle('Producer Price Index'), 'PPI');
});

test('formatEventTime converts 24h ET clock', () => {
  assert.equal(formatEventTime('08:30'), '8:30 AM ET');
  assert.equal(formatEventTime('14:00'), '2:00 PM ET');
  assert.equal(formatEventTime('00:00'), '12:00 AM ET');
  assert.equal(formatEventTime(undefined), null);
});

test('pickUpcomingEvents skips past dates and labels today/tomorrow', () => {
  const items: EconCalendarEvent[] = [
    { date: '2026-09-02', title: 'Consumer Price Index', kind: 'macro' },
    { date: '2026-09-03', title: 'Employment Situation', kind: 'macro', time: '08:30' },
    { date: '2026-09-04', title: 'FOMC Press Conference', kind: 'fed', time: '14:00' },
    { date: '2026-09-17', title: 'Gross Domestic Product', kind: 'macro' },
  ];
  const picked = pickUpcomingEvents(items, THU_ET, 2);
  assert.equal(picked.length, 2);
  assert.equal(picked[0]!.shortTitle, 'Jobs');
  assert.equal(picked[0]!.when, 'today 8:30 AM ET');
  assert.equal(picked[1]!.shortTitle, 'FOMC');
  assert.equal(picked[1]!.when, 'tomorrow 2:00 PM ET');
});

test('formatEventWhen uses weekday inside a week and month-day beyond', () => {
  assert.equal(
    formatEventWhen({ date: '2026-09-08', title: 'GDP', kind: 'macro' }, THU_ET),
    'Tue',
  );
  assert.match(
    formatEventWhen({ date: '2026-09-17', title: 'GDP', kind: 'macro' }, THU_ET),
    /Sep 17/,
  );
});

test('plainTakeaway strips markdown and cuts on a sentence', () => {
  const long = `${'SPX bid. '.repeat(5)}The tape stays risk-on into the print. Extra filler that should be dropped after the cap ${'word '.repeat(80)}`;
  const text = plainTakeaway(long, 80);
  assert.ok(text.endsWith('.'));
  assert.ok(text.length <= 80);
  assert.equal(plainTakeaway('Hourly market overview: lead with SPX/QQQ'), '');
  assert.equal(plainTakeaway('**Bold** [NVDA](https://x) led.'), 'Bold NVDA led.');
});

test('deskTakeaway only accepts @nowlobster with a real writeup', () => {
  const take = deskTakeaway(post());
  assert.ok(take);
  assert.match(take!.text, /SPX holds the 6500 handle/);
  assert.equal(take!.handle, DESK_HANDLE);

  assert.equal(deskTakeaway(post({ handle: 'thelobster' })), null);
  assert.equal(deskTakeaway(post({
    messages: [{ role: 'user', content: 'Hourly market overview: lead with SPX/QQQ' }],
    excerpt: 'Hourly market overview: lead with SPX/QQQ',
  })), null);
});

test('deskTakeaway prefers desk overview over the raw assistant body', () => {
  const take = deskTakeaway(post({
    messages: [{
      role: 'assistant',
      content: 'Long tool dump that is not the takeaway the reader wants on the homepage card.',
      desk: {
        overview: 'Constructive long: index bid with defined-risk calls into the CPI print tomorrow morning.',
      },
    }],
  }));
  assert.ok(take);
  assert.match(take!.text, /Constructive long/);
});

test('tapeAskPrompt prefers a today-print, then the biggest mover', () => {
  const highlights: TimelineRailHighlight[] = [
    { ticker: 'SPY', name: 'S&P 500', spot: 500, change_1d_pct: 0.2 },
    { ticker: '^VIX', name: 'VIX', spot: 18, change_1d_pct: 4.2 },
  ];
  const today = pickUpcomingEvents(
    [{ date: '2026-09-03', title: 'Consumer Price Index', kind: 'macro', time: '08:30' }],
    THU_ET,
  );
  assert.match(tapeAskPrompt(highlights, today), /CPI/);
  assert.match(tapeAskPrompt(highlights, []), /\^VIX/);
  assert.match(tapeAskPrompt([], []), /happening in the market right now/);
});

test('sessionHasContent is true when any slice landed', () => {
  assert.equal(sessionHasContent([], [], null), false);
  assert.equal(sessionHasContent([{ ticker: 'SPY', name: 'S&P 500', spot: 1, change_1d_pct: 0 }], [], null), true);
});
