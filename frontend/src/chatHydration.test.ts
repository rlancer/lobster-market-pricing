import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatAccessFromStatus,
  getMessagesUrlFromAgentHttp,
  parseGetMessagesPayload,
  pickChatHydrationSource,
  waitForAgentHttpUrl,
} from './chatHydration.ts';

test('chatAccessFromStatus maps agent auth gates', () => {
  assert.equal(chatAccessFromStatus(401), 'unauthorized');
  assert.equal(chatAccessFromStatus(403), 'forbidden');
  assert.equal(chatAccessFromStatus(200), 'ok');
  assert.equal(chatAccessFromStatus(500), 'ok');
  assert.equal(chatAccessFromStatus(null), 'ok');
});

test('pickChatHydrationSource prefers live DO messages over D1 backup', () => {
  assert.equal(pickChatHydrationSource({ liveCount: 2, backupCount: 4 }), 'live');
  assert.equal(pickChatHydrationSource({ liveCount: 0, backupCount: 4 }), 'backup');
  assert.equal(pickChatHydrationSource({ liveCount: 0, backupCount: 0 }), 'empty');
});

test('getMessagesUrlFromAgentHttp rewrites ws and appends the SDK path', () => {
  assert.equal(
    getMessagesUrlFromAgentHttp('wss://api.lobster.mp/agents/copilot-agent/abc'),
    'https://api.lobster.mp/agents/copilot-agent/abc/get-messages',
  );
  assert.equal(
    getMessagesUrlFromAgentHttp('https://api.lobster.mp/agents/copilot-agent/abc/'),
    'https://api.lobster.mp/agents/copilot-agent/abc/get-messages',
  );
  assert.equal(getMessagesUrlFromAgentHttp(''), null);
  assert.equal(getMessagesUrlFromAgentHttp('not a url'), null);
});

test('parseGetMessagesPayload ignores non-arrays', () => {
  assert.deepEqual(parseGetMessagesPayload([{ id: '1' }]), [{ id: '1' }]);
  assert.deepEqual(parseGetMessagesPayload(null), []);
  assert.deepEqual(parseGetMessagesPayload({ messages: [] }), []);
});

test('waitForAgentHttpUrl returns once the agent URL exists', async () => {
  let raw = '';
  const pending = waitForAgentHttpUrl(() => raw, { timeoutMs: 500 });
  raw = 'https://api.lobster.mp/agents/copilot-agent/x';
  assert.equal(await pending, raw);
});

test('waitForAgentHttpUrl times out when the URL never appears', async () => {
  assert.equal(await waitForAgentHttpUrl(() => '', { timeoutMs: 0 }), null);
});
