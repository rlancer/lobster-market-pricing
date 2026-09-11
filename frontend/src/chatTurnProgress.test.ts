import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLiveProjectedMessage,
  liveProjectedAssistant,
  nextLatchedLiveList,
  nextLatchedLiveText,
  nextStickScrollTop,
  pickLiveReasoning,
  reasoningTextFromParts,
} from './chatTurnProgress.ts';

test('reasoningTextFromParts joins reasoning and ignores other parts', () => {
  assert.equal(reasoningTextFromParts(undefined), '');
  assert.equal(reasoningTextFromParts([]), '');
  assert.equal(
    reasoningTextFromParts([
      { type: 'text', text: 'visible' },
      { type: 'reasoning', text: 'first. ' },
      { type: 'tool-run_query' },
      { type: 'reasoning', text: 'second.' },
    ]),
    'first. second.',
  );
});

test('nextLatchedLiveText keeps thinking through an empty busy snapshot', () => {
  const started = nextLatchedLiveText('Inspecting SPY…', '', true, 'u1', '');
  assert.equal(started.shown, 'Inspecting SPY…');
  assert.equal(started.latch, 'Inspecting SPY…');
  assert.equal(started.turnKey, 'u1');

  const replayCleared = nextLatchedLiveText('', started.latch, true, 'u1', started.turnKey);
  assert.equal(replayCleared.shown, 'Inspecting SPY…');
  assert.equal(replayCleared.latch, 'Inspecting SPY…');

  const nextDelta = nextLatchedLiveText('Inspecting SPY… then QQQ.', replayCleared.latch, true, 'u1', replayCleared.turnKey);
  assert.equal(nextDelta.shown, 'Inspecting SPY… then QQQ.');

  const settled = nextLatchedLiveText('', nextDelta.latch, false, '', nextDelta.turnKey);
  assert.equal(settled.shown, '');
  assert.equal(settled.latch, '');
  assert.equal(settled.turnKey, '');
});

test('pickLiveReasoning keeps the longer trace while replay catches up', () => {
  const full = 'Inspecting SPY options then QQQ.';
  assert.equal(pickLiveReasoning('', full), full);
  assert.equal(pickLiveReasoning('Inspecting', full), full);
  assert.equal(pickLiveReasoning(`${full} More.`, full), `${full} More.`);
  assert.equal(pickLiveReasoning('Now I will query the tape.', full), 'Now I will query the tape.');
});

test('nextLatchedLiveText does not collapse thinking when replay restarts from the first token', () => {
  const full = nextLatchedLiveText('Inspecting SPY options then QQQ.', '', true, 'u1', '');
  const replayHead = nextLatchedLiveText('Inspecting', full.latch, true, 'u1', full.turnKey);
  assert.equal(replayHead.shown, full.shown);
  const caughtUp = nextLatchedLiveText(`${full.shown} More.`, replayHead.latch, true, 'u1', replayHead.turnKey);
  assert.equal(caughtUp.shown, `${full.shown} More.`);
});

test('nextStickScrollTop stays pinned at the bottom as content grows', () => {
  const noOverflow = nextStickScrollTop({
    scrollTop: 0, scrollHeight: 100, clientHeight: 180, pinned: true,
  });
  assert.equal(noOverflow.scrollTop, 0);
  assert.equal(noOverflow.pinned, true);

  const grew = nextStickScrollTop({
    scrollTop: 0, scrollHeight: 400, clientHeight: 180, pinned: true,
  });
  assert.equal(grew.scrollTop, 220);
  assert.equal(grew.pinned, true);

  const userScrolledUp = nextStickScrollTop({
    scrollTop: 40, scrollHeight: 400, clientHeight: 180, pinned: false,
  });
  assert.equal(userScrolledUp.scrollTop, 40);
  assert.equal(userScrolledUp.pinned, false);

  const backNearBottom = nextStickScrollTop({
    scrollTop: 210, scrollHeight: 400, clientHeight: 180, pinned: false, thresholdPx: 24,
  });
  assert.equal(backNearBottom.pinned, true);
  assert.equal(backNearBottom.scrollTop, 220);
});

test('nextLatchedLiveText does not leak thinking into the next user turn', () => {
  const prior = nextLatchedLiveText('Old thought', '', true, 'u1', '');
  const nextTurn = nextLatchedLiveText('', prior.latch, true, 'u2', prior.turnKey);
  assert.equal(nextTurn.shown, '');
  assert.equal(nextTurn.latch, '');
  assert.equal(nextTurn.turnKey, 'u2');
});

test('nextLatchedLiveList keeps tools through an empty busy snapshot', () => {
  const tools = [{ name: 'run_query' }];
  const started = nextLatchedLiveList(tools, [], true, 'u1', '');
  assert.deepEqual(started.shown, tools);
  const cleared = nextLatchedLiveList([], started.latch, true, 'u1', started.turnKey);
  assert.deepEqual(cleared.shown, tools);
  const settled = nextLatchedLiveList([], cleared.latch, false, '', cleared.turnKey);
  assert.deepEqual(settled.shown, []);
  assert.deepEqual(settled.latch, []);
});

test('liveProjectedAssistant is the last assistant after the latest user while live', () => {
  const messages = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
    { id: 'a3', role: 'assistant' },
  ];
  assert.equal(liveProjectedAssistant(messages, true)?.id, 'a3');
  assert.equal(liveProjectedAssistant(messages, false)?.id, undefined);
  assert.equal(liveProjectedAssistant([{ id: 'u1', role: 'user' }], true)?.id, undefined);
});

test('isLiveProjectedMessage matches coalesced or raw live ids', () => {
  assert.equal(isLiveProjectedMessage('a1', ['a1', 'a2']), true);
  assert.equal(isLiveProjectedMessage('a1', [undefined, 'a2']), false);
  assert.equal(isLiveProjectedMessage('coalesced', ['empty-recovery', 'coalesced']), true);
});
