import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSqlQueries, sqlQueriesFromMessage } from './sqlQueries.ts';

test('mergeSqlQueries keeps first-seen order and drops duplicates', () => {
  assert.deepEqual(
    mergeSqlQueries(['SELECT 1', 'SELECT 2'], ['SELECT 1', 'SELECT 3']),
    ['SELECT 1', 'SELECT 2', 'SELECT 3'],
  );
  assert.deepEqual(mergeSqlQueries(['  SELECT 1  '], null, undefined), ['SELECT 1']);
});

test('sqlQueriesFromMessage uses queries[] and always includes legacy sql', () => {
  assert.deepEqual(sqlQueriesFromMessage({ sql: 'SELECT last' }), ['SELECT last']);
  assert.deepEqual(
    sqlQueriesFromMessage({
      sql: 'SELECT last',
      queries: ['SELECT first', 'SELECT last'],
    }),
    ['SELECT first', 'SELECT last'],
  );
  assert.deepEqual(sqlQueriesFromMessage({ queries: ['SELECT a'] }), ['SELECT a']);
  assert.deepEqual(sqlQueriesFromMessage({}), []);
});
