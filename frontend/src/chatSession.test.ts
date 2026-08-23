import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatHistoryTimeLabel,
  groupUserChatsByRelativeTime,
  sortUserChats,
} from './chatSession.ts';

/** Fixed "now": Wednesday 2026-08-19 15:00 local. */
const NOW = new Date(2026, 7, 19, 15, 0, 0, 0).getTime();

function chat(id: string, updatedAt: number) {
  return { chat_id: id, created_at: updatedAt, updated_at: updatedAt, title: id };
}

test('chatHistoryTimeLabel buckets relative days', () => {
  assert.equal(chatHistoryTimeLabel(new Date(2026, 7, 19, 9, 0, 0, 0).getTime(), NOW), 'Today');
  assert.equal(chatHistoryTimeLabel(new Date(2026, 7, 18, 23, 0, 0, 0).getTime(), NOW), 'Yesterday');
  assert.equal(chatHistoryTimeLabel(new Date(2026, 7, 17, 12, 0, 0, 0).getTime(), NOW), 'Last 7 days');
  assert.equal(chatHistoryTimeLabel(new Date(2026, 7, 13, 0, 0, 0, 0).getTime(), NOW), 'Last 7 days');
  assert.equal(chatHistoryTimeLabel(new Date(2026, 7, 12, 23, 0, 0, 0).getTime(), NOW), 'Last 30 days');
  assert.equal(chatHistoryTimeLabel(new Date(2026, 6, 21, 0, 0, 0, 0).getTime(), NOW), 'Last 30 days');
});

test('chatHistoryTimeLabel uses month / month-year for older chats', () => {
  assert.equal(chatHistoryTimeLabel(new Date(2026, 6, 1, 12, 0, 0, 0).getTime(), NOW), 'July');
  assert.equal(
    chatHistoryTimeLabel(new Date(2025, 11, 10, 12, 0, 0, 0).getTime(), NOW),
    new Date(2025, 11, 10).toLocaleString(undefined, { month: 'long', year: 'numeric' }),
  );
});

test('chatHistoryTimeLabel treats non-finite timestamps as Older', () => {
  assert.equal(chatHistoryTimeLabel(Number.NaN, NOW), 'Older');
  assert.equal(chatHistoryTimeLabel(Number.POSITIVE_INFINITY, NOW), 'Older');
});

test('groupUserChatsByRelativeTime preserves newest-first order and skips empty buckets', () => {
  const items = sortUserChats([
    chat('old-month', new Date(2026, 5, 1, 12, 0, 0, 0).getTime()),
    chat('today-a', new Date(2026, 7, 19, 14, 0, 0, 0).getTime()),
    chat('yesterday', new Date(2026, 7, 18, 10, 0, 0, 0).getTime()),
    chat('today-b', new Date(2026, 7, 19, 10, 0, 0, 0).getTime()),
    chat('week', new Date(2026, 7, 15, 10, 0, 0, 0).getTime()),
    chat('month', new Date(2026, 7, 1, 10, 0, 0, 0).getTime()),
  ]);

  const groups = groupUserChatsByRelativeTime(items, NOW);
  assert.deepEqual(
    groups.map((group) => ({ label: group.label, ids: group.items.map((item) => item.chat_id) })),
    [
      { label: 'Today', ids: ['today-a', 'today-b'] },
      { label: 'Yesterday', ids: ['yesterday'] },
      { label: 'Last 7 days', ids: ['week'] },
      { label: 'Last 30 days', ids: ['month'] },
      { label: 'June', ids: ['old-month'] },
    ],
  );
});
