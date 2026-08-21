import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SCOPE_CLASSIFIER_SYSTEM,
  SCOPE_REJECTED_ERROR,
  latestUserText,
  parseScopeLabel,
} from '../src/copilot-scope.ts';

test('scope rejected error is the stable client contract', () => {
  assert.equal(SCOPE_REJECTED_ERROR, 'No data to answer.');
});

test('scope classifier treats spot crypto as in-scope market data', () => {
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /BTC-USD/);
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /spot crypto/i);
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /Bitcoin/);
  assert.doesNotMatch(
    SCOPE_CLASSIFIER_SYSTEM,
    /US equities & ETF options market-data Copilot/,
  );
});

test('scope classifier treats Treasury yields / rates as in-scope', () => {
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /Treasury yields/i);
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /yield curve/i);
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /DGS\*/);
  assert.match(SCOPE_CLASSIFIER_SYSTEM, /SOFR/);
});

test('parseScopeLabel accepts exact and padded labels', () => {
  assert.equal(parseScopeLabel('IN_SCOPE'), true);
  assert.equal(parseScopeLabel('OUT_OF_SCOPE'), false);
  assert.equal(parseScopeLabel(' in_scope\n'), true);
  assert.equal(parseScopeLabel('OUT_OF_SCOPE.'), false);
  assert.equal(parseScopeLabel('Label: OUT_OF_SCOPE'), false);
  assert.equal(parseScopeLabel('maybe'), null);
  assert.equal(parseScopeLabel(''), null);
});

test('latestUserText returns the newest user text part', () => {
  assert.equal(latestUserText([]), '');
  assert.equal(latestUserText([
    { role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
  ]), '');
  assert.equal(latestUserText([
    { role: 'user', parts: [{ type: 'text', text: 'SPY IV?' }] },
    { role: 'assistant', parts: [{ type: 'text', text: '...' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Which lawn chair should I buy' }] },
  ]), 'Which lawn chair should I buy');
});
