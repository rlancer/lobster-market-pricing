import assert from "node:assert/strict";
import test from "node:test";
import { chartFitsResult, inferChartSpec, resolveColumn, wantsChart } from "../src/chart-spec.ts";

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
    title: "implied_vol vs strike",
    xLabel: "strike",
    yLabel: "implied_vol",
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
