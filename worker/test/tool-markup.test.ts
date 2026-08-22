import assert from "node:assert/strict";
import test from "node:test";
import { hasLeakedToolMarkup, stripLeakedToolMarkup } from "../src/tool-markup.ts";

test("stripLeakedToolMarkup removes DeepSeek DSML tool envelopes", () => {
  const raw = [
    "The chart and data are ready. Now I need to publish the desk view.",
    "",
    "<｜DSML｜tool_calls>",
    "<｜DSML｜invoke name=\"render_chart\">",
    "<｜DSML｜parameter name=\"kind\" string=\"true\">line</｜DSML｜parameter>",
    "</｜DSML｜invoke>",
    "</｜DSML｜tool_calls>",
  ].join("\n");
  const cleaned = stripLeakedToolMarkup(raw);
  assert.match(cleaned, /desk view/);
  assert.equal(hasLeakedToolMarkup(cleaned), false);
  assert.doesNotMatch(cleaned, /DSML|render_chart|tool_calls/);
});

test("hasLeakedToolMarkup detects DSML and XML tool_calls", () => {
  assert.equal(hasLeakedToolMarkup("plain takeaway."), false);
  assert.equal(hasLeakedToolMarkup("<｜DSML｜tool_calls>x</｜DSML｜tool_calls>"), true);
  assert.equal(hasLeakedToolMarkup("<tool_calls><tool_call>x</tool_call></tool_calls>"), true);
});
