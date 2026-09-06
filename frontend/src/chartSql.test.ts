import assert from 'node:assert/strict';
import test from 'node:test';
import { executableSql, pickChartSqlCandidates } from './chartSql.ts';

test('executableSql unwraps a cached-frame slice comment', () => {
  const sql = executableSql(`-- slice of cached frame 'top_calls'
-- source: SELECT symbol, volume FROM options.option_contracts LIMIT 10`);
  assert.equal(sql, 'SELECT symbol, volume FROM options.option_contracts LIMIT 10');
});

test('pickChartSqlCandidates prefers SQL that mentions the chart columns', () => {
  const candidates = pickChartSqlCandidates({
    sql: "SELECT date, dgs10 FROM options.ohlc LIMIT 1",
    queries: [
      "SELECT ticker, spot_price, as_of_date FROM options.underlying_snapshots WHERE ticker='CYTK'",
      "SELECT date, dgs10 FROM options.ohlc LIMIT 1",
    ],
    chart: { kind: 'line', x: 'as_of_date', y: 'spot_price' },
  });
  assert.equal(candidates[0], "SELECT ticker, spot_price, as_of_date FROM options.underlying_snapshots WHERE ticker='CYTK'");
});
