import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeTone,
  defaultOverlayDate,
  formatVixPct,
  formatVixPx,
  isVixPageTicker,
  tickerLink,
} from './vixPage.ts';

test('isVixPageTicker covers cash VIX and monthly VX', () => {
  assert.equal(isVixPageTicker('^VIX'), true);
  assert.equal(isVixPageTicker('vix'), true);
  assert.equal(isVixPageTicker('^VIX3M'), true);
  assert.equal(isVixPageTicker('VVIX'), true);
  assert.equal(isVixPageTicker('VXU26'), true);
  assert.equal(isVixPageTicker('VIXY'), false);
  assert.equal(isVixPageTicker('SPY'), false);
});

test('tickerLink sends VIX and VX monthals to /vix', () => {
  assert.deepEqual(tickerLink('VXU26'), { to: '/vix' });
  assert.deepEqual(tickerLink('^VIX'), { to: '/vix' });
  assert.deepEqual(tickerLink('SPY'), { to: '/research/$ticker', params: { ticker: 'SPY' } });
});

test('formatters and overlay default', () => {
  assert.equal(formatVixPx(16.4), '16.40');
  assert.equal(formatVixPct(-3.1), '−3.10%');
  assert.equal(changeTone(-1), 'down');
  assert.equal(defaultOverlayDate('2026-09-07', ['2026-09-07', '2026-09-04', '2026-09-03']), '2026-09-04');
  assert.equal(defaultOverlayDate('2026-09-03', ['2026-09-03']), null);
});
