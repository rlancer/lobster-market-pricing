import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSqlSchema, type LakeTable } from '../src/chat-sql.ts';

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

test('CTE names are valid FROM/JOIN targets, not unknown lake tables', () => {
  // Regression from share vMdGNSQ8G4WCl42CcsukdsRi ("Best calls to sell"):
  // the validator treated CTE aliases as options.* tables and forced the
  // model to flatten, burning the turn before a final answer.
  for (const sql of [
    `WITH base AS (SELECT symbol FROM options.option_contracts LIMIT 5)
     SELECT symbol FROM base LIMIT 5`,
    `WITH ranked AS (
       SELECT symbol, open_interest,
              ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_interest DESC) rn
       FROM options.option_contracts
     )
     SELECT symbol, open_interest FROM ranked WHERE rn = 1 LIMIT 20`,
    `WITH a AS (SELECT symbol FROM options.option_contracts LIMIT 10),
          b AS (SELECT symbol FROM a)
     SELECT b.symbol FROM b LIMIT 10`,
    `WITH base (sym) AS (SELECT symbol FROM options.option_contracts LIMIT 5)
     SELECT sym FROM base LIMIT 5`,
  ]) {
    const errors = errorMessages(sql);
    assert.equal(errors.length, 0, `unexpected errors for CTE SQL: ${errors.join('; ')}`);
  }
});

test('unknown real tables are still rejected even inside WITH queries', () => {
  const errors = errorMessages(
    `WITH base AS (SELECT symbol FROM options.not_a_table LIMIT 5) SELECT * FROM base LIMIT 5`,
  );
  assert.ok(errors.some((m) => m.includes('Unknown table options.not_a_table')));
});

test('bare SELECT probes without a lake table are rejected', () => {
  // Regression: chat c7d67546… ("best shorts") forced run_query on SELECT 1 /
  // SELECT 'test' AS t until the 10-step budget burned; R2 then returned
  // "query must reference at least one table".
  for (const sql of ["SELECT 1", "SELECT 'test' AS t", "SELECT 1 AS value"]) {
    const errors = errorMessages(sql);
    assert.ok(
      errors.some((m) => m.includes('bare SELECT probes are not allowed')),
      `missed bare probe for: ${sql} → ${errors.join('; ')}`,
    );
  }
});

test('CTE-only SQL that never touches a lake table is rejected', () => {
  const errors = errorMessages(`WITH x AS (SELECT 1 AS n) SELECT n FROM x LIMIT 1`);
  assert.ok(errors.some((m) => m.includes('CTE-only SQL must still SELECT FROM')));
});

test('real lake FROM still validates cleanly', () => {
  const errors = errorMessages(
    'SELECT symbol FROM options.option_contracts WHERE open_interest > 0 LIMIT 5',
  );
  assert.equal(errors.length, 0, errors.join('; '));
});

test('applyColumnSynonyms rewrites symbol→ticker on underlying_snapshots', async () => {
  const { applyColumnSynonyms } = await import('../src/chat-sql.ts');
  const snapTables: LakeTable[] = [
    {
      name: 'underlying_snapshots',
      row_count: 1,
      columns: [
        { name: 'ticker', type: 'string' },
        { name: 'spot_price', type: 'float' },
        { name: 'name', type: 'string' },
      ],
      sample: [],
    },
    {
      name: 'option_contracts',
      row_count: 1,
      columns: [
        { name: 'symbol', type: 'string' },
        { name: 'type', type: 'string' },
      ],
      sample: [],
    },
  ];

  // GME-style failure: unqualified symbol on a ticker-only table.
  const solo = applyColumnSynonyms(
    "SELECT symbol, spot_price FROM options.underlying_snapshots WHERE symbol = 'GME' LIMIT 5",
    snapTables,
  );
  assert.match(solo.sql, /\bticker\b/i);
  assert.doesNotMatch(solo.sql, /\bsymbol\b/i);
  assert.ok(solo.rewrites.some((r) => /symbol → ticker/i.test(r)));
  assert.equal(validateSqlSchema(solo.sql, snapTables).filter((i) => i.severity === 'error').length, 0);

  // Mixed join: only the snapshots side is rewritten.
  const joined = applyColumnSynonyms(
    `SELECT c.symbol, u.symbol AS spot_sym, u.spot_price
     FROM options.option_contracts c
     JOIN options.underlying_snapshots u ON c.symbol = u.symbol
     WHERE c.symbol = 'GME' LIMIT 20`,
    snapTables,
  );
  assert.match(joined.sql, /c\.symbol/i);
  assert.match(joined.sql, /u\.ticker/i);
  assert.doesNotMatch(joined.sql, /u\.symbol/i);
  assert.ok(joined.rewrites.some((r) => /underlying_snapshots\.symbol → ticker/i.test(r)));

  // Literals must not be rewritten.
  const lit = applyColumnSynonyms(
    "SELECT ticker FROM options.underlying_snapshots WHERE name = 'symbol' LIMIT 1",
    snapTables,
  );
  assert.match(lit.sql, /'symbol'/);
});
