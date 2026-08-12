import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSqlSchema, type LakeTable } from '../src/copilot-sql.ts';

const tables: LakeTable[] = [
  {
    name: 'option_contracts',
    row_count: 1,
    columns: [
      { name: 'symbol', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'open_interest', type: 'bigint' },
      { name: 'expiration', type: 'string' },
    ],
    sample: [],
  },
];

const errorMessages = (sql: string) =>
  validateSqlSchema(sql, tables).filter((issue) => issue.severity === 'error').map((issue) => issue.message);

test('call/put string literals are not treated as mutating SQL', () => {
  // Regression: the mutating-keyword regex previously matched the literal
  // 'call' inside WHERE type = 'call' and rejected every option-type query.
  for (const sql of [
    "SELECT symbol, COUNT(*) n FROM options.option_contracts WHERE type = 'call' GROUP BY symbol LIMIT 5",
    "SELECT COUNT(*) n FROM options.option_contracts WHERE type IN ('call','put') LIMIT 5",
    "SELECT symbol FROM options.option_contracts WHERE type = 'put' LIMIT 5",
    "SELECT * FROM options.option_contracts WHERE type = 'call' AND open_interest > 0 LIMIT 10",
  ]) {
    const errors = errorMessages(sql);
    assert.ok(!errors.some((m) => m === 'Mutating SQL is not allowed.'), `false flag for: ${sql}`);
  }
});

test('mutating statements are still rejected', () => {
  for (const sql of [
    'DELETE FROM options.option_contracts',
    'UPDATE options.option_contracts SET symbol = \'X\'',
    'INSERT INTO options.option_contracts VALUES (1)',
    'DROP TABLE options.option_contracts',
  ]) {
    assert.ok(errorMessages(sql).includes('Mutating SQL is not allowed.'), `missed mutating SQL: ${sql}`);
  }
});

test('semicolons inside string literals are not multiple statements', () => {
  const errors = errorMessages("SELECT 'a;b' AS x FROM options.option_contracts LIMIT 1");
  assert.ok(!errors.includes('Multiple SQL statements are not allowed.'));
});

test('real multiple statements are still rejected', () => {
  assert.ok(errorMessages('SELECT * FROM options.option_contracts LIMIT 1; SELECT * FROM options.option_contracts').includes('Multiple SQL statements are not allowed.'));
});
