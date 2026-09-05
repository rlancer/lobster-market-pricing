import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asOfInstant,
  isHistoricalAsOf,
  isIsoDateString,
  parseAsOfDate,
  parseAsOfSearch,
} from './asOfDate.ts';

test('isIsoDateString rejects impossible calendar days', () => {
  assert.equal(isIsoDateString('2026-03-15'), true);
  assert.equal(isIsoDateString('2026-02-30'), false);
  assert.equal(isIsoDateString('2026-13-01'), false);
  assert.equal(isIsoDateString('26-03-15'), false);
});

test('parseAsOfDate clamps future days to today', () => {
  assert.equal(parseAsOfDate('2026-03-15', '2026-09-05'), '2026-03-15');
  assert.equal(parseAsOfDate('2026-09-05', '2026-09-05'), '2026-09-05');
  assert.equal(parseAsOfDate('2026-12-01', '2026-09-05'), '2026-09-05');
  assert.equal(parseAsOfDate('not-a-date', '2026-09-05'), null);
  assert.equal(parseAsOfDate(' 2026-03-15 ', '2026-09-05'), '2026-03-15');
});

test('parseAsOfSearch only accepts strings', () => {
  assert.equal(parseAsOfSearch('2026-03-15', '2026-09-05'), '2026-03-15');
  assert.equal(parseAsOfSearch(undefined, '2026-09-05'), undefined);
  assert.equal(parseAsOfSearch(20260315, '2026-09-05'), undefined);
});

test('isHistoricalAsOf is strictly before today', () => {
  assert.equal(isHistoricalAsOf('2026-03-15', '2026-09-05'), true);
  assert.equal(isHistoricalAsOf('2026-09-05', '2026-09-05'), false);
  assert.equal(isHistoricalAsOf(undefined, '2026-09-05'), false);
});

test('asOfInstant stays on the ET calendar day', () => {
  const d = asOfInstant('2026-03-15');
  const et = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  assert.equal(et, '2026-03-15');
});
