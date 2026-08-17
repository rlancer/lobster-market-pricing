import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntradayUrl,
  isoDateTime,
  parseYahooIntraday,
} from "../src/yahoo-intraday.ts";

test("buildIntradayUrl encodes Yahoo share-class form", () => {
  const url = buildIntradayUrl("BRK.B");
  assert.match(url, /BRK-B/);
  assert.match(url, /interval=5m/);
  assert.match(url, /range=1d/);
});

test("isoDateTime applies gmtoffset as exchange-local wall time", () => {
  // 2026-08-17 13:30 UTC + (-4h) = 09:30 ET
  assert.equal(isoDateTime(1_786_973_400, -4 * 3600), "2026-08-17T09:30");
});

test("parseYahooIntraday returns ascending bars and drops null closes", () => {
  const payload = {
    chart: {
      result: [{
        meta: { gmtoffset: -14400 },
        timestamp: [1000, 1300, 1600],
        indicators: {
          quote: [{
            open: [10, 11, 12],
            high: [10.5, 11.5, 12.5],
            low: [9.5, 10.5, 11.5],
            close: [10.2, null, 12.1],
            volume: [100, 200, 300],
          }],
        },
      }],
    },
  };
  const bars = parseYahooIntraday(payload, "V");
  assert.equal(bars.length, 2);
  assert.equal(bars[0]?.close, 10.2);
  assert.equal(bars[1]?.close, 12.1);
  assert.ok(bars[0]!.date < bars[1]!.date);
});

test("parseYahooIntraday throws when Yahoo returns no result", () => {
  assert.throws(() => parseYahooIntraday({ chart: { result: [] } }, "V"));
});
