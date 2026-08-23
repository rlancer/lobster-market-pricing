import assert from 'node:assert/strict';
import test from 'node:test';
import { reconnectDelayMs, socketStateFromReadyState } from './chatConnection.ts';

test('socketStateFromReadyState treats initial CONNECTING as connecting, not reconnecting', () => {
  assert.equal(socketStateFromReadyState(0, true, false), 'connecting');
  assert.equal(socketStateFromReadyState(3, true, false), 'connecting');
});

test('socketStateFromReadyState reports reconnecting only after an open session', () => {
  assert.equal(socketStateFromReadyState(0, true, true), 'reconnecting');
  assert.equal(socketStateFromReadyState(3, true, true), 'reconnecting');
});

test('socketStateFromReadyState maps OPEN and offline', () => {
  assert.equal(socketStateFromReadyState(1, true, false), 'open');
  assert.equal(socketStateFromReadyState(1, true, true), 'open');
  assert.equal(socketStateFromReadyState(0, false, false), 'offline');
  assert.equal(socketStateFromReadyState(3, false, true), 'offline');
});

test('reconnectDelayMs backs off and caps', () => {
  assert.equal(reconnectDelayMs(0), 400);
  assert.equal(reconnectDelayMs(1), 800);
  assert.equal(reconnectDelayMs(2), 1600);
  assert.equal(reconnectDelayMs(10), 10_000);
});
