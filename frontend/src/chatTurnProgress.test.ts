import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLiveProjectedMessage,
  liveProjectedAssistant,
  nextLatchedLiveList,
  nextLatchedLiveText,
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
