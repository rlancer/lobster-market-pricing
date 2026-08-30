import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  americanOptionMark,
  blackScholesPrice,
  impliedVol,
  normCdf,
  occExpirationIso,
  yearFraction,
} from './schwabBlackScholes.ts';

test('normCdf matches known standard-normal values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 5e-4);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 5e-4);
});

test('impliedVol round-trips a CAR-like put fill', () => {
  const years = yearFraction('2026-04-22', '2026-06-18');
  const iv = impliedVol({
    right: 'P',
    spot: 443.94,
    strike: 390,
    years,
    price: 83.09,
  });
  assert.ok(iv != null && iv > 0.5, `expected high vol, got ${iv}`);
  const priced = blackScholesPrice({
    right: 'P',
    spot: 443.94,
    strike: 390,
    years,
    vol: iv!,
  });
  assert.ok(Math.abs(priced - 83.09) < 0.05);
});

test('americanOptionMark never marks a put below intrinsic', () => {
  const years = yearFraction('2026-04-23', '2026-06-18');
  const mark = americanOptionMark({
    right: 'P',
    spot: 229.14,
    strike: 390,
    years,
    vol: 1.2,
  });
  assert.ok(mark >= 390 - 229.14 - 1e-9);
});

test('occExpirationIso reads OCC YYMMDD as a calendar date', () => {
  assert.equal(occExpirationIso('260618'), '2026-06-18');
  assert.equal(occExpirationIso('CAR'), null);
});
