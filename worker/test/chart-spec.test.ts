import assert from "node:assert/strict";
import test from "node:test";
import {
  chartFitsResult,
  critiqueChartSpec,
  inferChartSpec,
  normalizeChartSpec,
  resolveColumn,
  wantsChart,
} from "../src/chart-spec.ts";

test("wantsChart matches smile/chart phrasing", () => {
  assert.equal(wantsChart("Chart the IV smile for NVDA"), true);
  assert.equal(wantsChart("plot implied vol vs strike"), true);
  assert.equal(wantsChart("Which sector has the most open interest?"), false);
});

test("resolveColumn is case-insensitive", () => {
  assert.equal(resolveColumn(["implied_vol", "strike"], "Implied_Vol"), "implied_vol");
  assert.equal(resolveColumn(["strike"], "dte"), null);
});

test("inferChartSpec builds a smile from strike/iv/type", () => {
  const spec = inferChartSpec(
    ["strike", "implied_vol", "type"],
    [
      { strike: 220, implied_vol: 0.31, type: "call" },
      { strike: 220, implied_vol: 0.33, type: "put" },
      { strike: 230, implied_vol: 0.30, type: "call" },
    ],
  );
  assert.deepEqual(spec, {
    kind: "line",
    x: "strike",
    y: "implied_vol",
    series: "type",
    title: "Implied vol vs Strike",
    xLabel: "Strike",
    yLabel: "Implied vol",
  });
  assert.equal(chartFitsResult(spec!, ["strike", "implied_vol", "type"]), true);
});

test("inferChartSpec prefers expiration series for a surface", () => {
  const spec = inferChartSpec(
    ["strike", "implied_vol", "expiration", "type"],
    [
      { strike: 220, implied_vol: 0.31, expiration: "2026-08-21", type: "call" },
      { strike: 220, implied_vol: 0.35, expiration: "2026-09-18", type: "call" },
    ],
  );
  assert.equal(spec?.x, "strike");
  assert.equal(spec?.y, "implied_vol");
  assert.equal(spec?.series, "expiration");
});

test("normalizeChartSpec drops a measure used as series", () => {
  const spec = normalizeChartSpec(
    { kind: "line", x: "date", y: "value", series: "value", title: "US 10Y (DGS10) — grinding back toward cycle highs", yLabel: "Yield %" },
    ["date", "value"],
    [
      { date: "2026-06-01", value: 4.2 },
      { date: "2026-07-01", value: 4.3 },
      { date: "2026-08-01", value: 4.1 },
      { date: "2026-09-01", value: 4.4 },
      { date: "2026-09-02", value: 4.35 },
    ],
  );
  assert.equal(spec?.series, undefined);
  assert.equal(spec?.title, "US 10Y (DGS10) — grinding back toward cycle highs");
  assert.equal(spec?.yLabel, "Yield %");
});

test("critiqueChartSpec rejects missing y values", () => {
  const judged = critiqueChartSpec(
    { kind: "line", x: "date", y: "close" },
    ["date", "close"],
    [{ date: "2026-09-01", close: "n/a" }],
  );
  assert.equal(judged.ok, false);
});

test("critiqueChartSpec notes a wide ticker table", () => {
  const judged = critiqueChartSpec(
    { kind: "line", x: "trade_date", y: "xlk", series: "xlk", title: "Sector rotation" },
    ["trade_date", "xlk", "xlf", "xle", "xlu"],
    [
      { trade_date: "2026-08-31", xlk: 230, xlf: 50, xle: 90, xlu: 70 },
      { trade_date: "2026-09-01", xlk: 232, xlf: 51, xle: 89, xlu: 71 },
    ],
  );
  assert.equal(judged.ok, true);
  if (judged.ok) {
    assert.equal(judged.spec.series, undefined);
    assert.match(judged.notes.join(" "), /Wide table/);
  }
});
