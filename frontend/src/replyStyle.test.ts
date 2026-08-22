import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REPLY_STYLE,
  parseReplyPref,
  REPLY_NOTE_MAX,
  REPLY_STYLE_IDS,
  REPLY_STYLE_OPTIONS,
} from './replyStyle.ts';

test('frontend reply styles match the three canned Worker ids', () => {
  assert.deepEqual([...REPLY_STYLE_IDS], ['desk', 'fund', 'learner']);
  assert.deepEqual(REPLY_STYLE_OPTIONS.map((option) => option.id), [...REPLY_STYLE_IDS]);
  assert.equal(DEFAULT_REPLY_STYLE, 'desk');
  assert.equal(REPLY_NOTE_MAX, 240);
});

test('parseReplyPref clamps notes and falls back to desk', () => {
  assert.deepEqual(parseReplyPref(null), { style: 'desk', note: '' });
  assert.deepEqual(
    parseReplyPref({ style: 'learner', note: '  new to spreads  ' }),
    { style: 'learner', note: 'new to spreads' },
  );
  assert.equal(parseReplyPref({ style: 'yolo', note: 'x'.repeat(300) }).style, 'desk');
  assert.equal(parseReplyPref({ style: 'fund', note: 'x'.repeat(300) }).note.length, REPLY_NOTE_MAX);
});
