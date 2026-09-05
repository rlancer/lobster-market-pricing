import assert from "node:assert/strict";
import test from "node:test";
import {
  isUnfilteredOptionFlowSql,
  judgeOverviewRun,
  leakSymbolsInTapeSummary,
} from "../src/bot-overview-e2e.ts";

test("flags the original share SQL as an unfiltered flow probe", () => {
  const sql =
    "SELECT symbol, type, SUM(volume) AS vol FROM options.option_contracts " +
    "WHERE as_of_date='2026-09-04' GROUP BY symbol, type ORDER BY vol DESC LIMIT 20";
  assert.equal(isUnfilteredOptionFlowSql(sql), true);
});

test("accepts get_market_tape sleeve SQL", () => {
  const sql =
    "SELECT symbol, type, SUM(volume) AS vol FROM options.option_contracts " +
    "WHERE as_of_date = '2026-09-04' AND symbol IN ('SPY', 'QQQ', 'IWM') " +
    "GROUP BY symbol, type ORDER BY vol DESC LIMIT 24";
  assert.equal(isUnfilteredOptionFlowSql(sql), false);
});

test("leakSymbolsInTapeSummary only matches flow rows", () => {
  assert.deepEqual(
    leakSymbolsInTapeSummary("  EWY call  vol=9.99M  oi=1"),
    ["EWY"],
  );
  assert.deepEqual(
    leakSymbolsInTapeSummary("Do not treat EWY as unusual flow."),
    [],
  );
});

test("judgeOverviewRun requires a successful tape and rejects the leak SQL", () => {
  const fail = judgeOverviewRun({
    triggerOk: true,
    shareId: "abc",
    tools: [{
      tool_name: "run_query",
      ok: true,
      sql: "SELECT symbol, SUM(volume) AS vol FROM options.option_contracts GROUP BY symbol ORDER BY vol DESC LIMIT 20",
    }],
  });
  assert.equal(fail.ok, false);
  assert.ok(fail.reasons.some((r) => r.includes("get_market_tape")));
  assert.ok(fail.reasons.some((r) => r.includes("unfiltered")));

  const pass = judgeOverviewRun({
    triggerOk: true,
    shareId: "abc",
    tools: [{
      tool_name: "get_market_tape",
      ok: true,
      summary: "Market tape (liquid sleeve — indexes, sector SPDRs).\n  SPY call  vol=1.20M",
    }],
  });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.reasons, []);
});
