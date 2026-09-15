import assert from 'node:assert/strict';
import test from 'node:test';
import { fmtRr, pnlTone } from './kalshiParlayBooks.ts';
import { EXPERIMENTS, experimentBySlug } from './catalog.ts';

test('fmtRr and pnlTone', () => {
  assert.equal(fmtRr(4.05), '4.05:1');
  assert.equal(fmtRr(null), '—');
  assert.equal(pnlTone(23.3), 'green');
  assert.equal(pnlTone(-26.8), 'red');
  assert.equal(pnlTone(0), 'gray');
});

test('parlay companion notebooks are cataloged', () => {
  assert.ok(experimentBySlug('kalshi-parlay-books'));
  assert.ok(experimentBySlug('kalshi-parlay-payoffs'));
  assert.equal(EXPERIMENTS.filter((item) => item.slug.startsWith('kalshi-parlay')).length, 3);
});
