import assert from 'node:assert/strict';
import test from 'node:test';
import { flagLabel, fmtGap, fmtProb, fmtRho, gapTone } from './kalshiParlays.ts';

test('formats probabilities as cents', () => {
  assert.equal(fmtProb(0.615), '61.5¢');
  assert.equal(fmtProb(null), '—');
});

test('formats gaps with a sign', () => {
  assert.equal(fmtGap(0.066), '+6.6¢');
  assert.equal(fmtGap(-0.049), '-4.9¢');
  assert.equal(fmtGap(null), '—');
});

test('formats rho and flags', () => {
  assert.equal(fmtRho(0.42), '0.42');
  assert.equal(flagLabel('independence_gap'), 'vs independent');
  assert.equal(gapTone(0.05), 'green');
  assert.equal(gapTone(-0.05), 'red');
  assert.equal(gapTone(0.001), 'gray');
});
