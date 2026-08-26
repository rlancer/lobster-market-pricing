import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deterministicShuffle,
  probeRetryDelayMs,
} from './text-vs-image-runner-utils.mjs';

test('deterministicShuffle is stable without mutating input', () => {
  const input = ['a', 'b', 'c', 'd', 'e'];
  const first = deterministicShuffle(input, 42);
  const second = deterministicShuffle(input, 42);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, deterministicShuffle(input, 43));
  assert.deepEqual(input, ['a', 'b', 'c', 'd', 'e']);
});

test('probeRetryDelayMs retries transient failures and honors Retry-After', () => {
  assert.equal(probeRetryDelayMs({ status: 500 }, 2), 1_000);
  assert.equal(probeRetryDelayMs({ status: 429, retryAfter: '3' }, 1), 3_000);
  assert.equal(probeRetryDelayMs(new TypeError('network error'), 1), 500);
});

test('probeRetryDelayMs does not retry permanent HTTP failures', () => {
  assert.equal(probeRetryDelayMs({ status: 400 }, 1), null);
  assert.equal(probeRetryDelayMs({ status: 403 }, 1), null);
});
