import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHWAB_MARKETDATA_BASE,
  candleSessionDate,
  fetchSchwabPriceHistory,
  isPriceHistorySymbol,
  normalizeSchwabPriceHistory,
  priceHistoryLookbackStart,
} from "../src/schwab-marketdata.ts";
import { SchwabApiError } from "../src/schwab-portfolio.ts";

test("priceHistoryLookbackStart pads 21 calendar days before the chart", () => {
  assert.equal(priceHistoryLookbackStart("2026-08-01"), "2026-07-11");
});

test("isPriceHistorySymbol allows equity roots and rejects OCC / junk", () => {
  assert.equal(isPriceHistorySymbol("TLT"), true);
  assert.equal(isPriceHistorySymbol("BRK/B"), true);
  assert.equal(isPriceHistorySymbol("BRK.B"), true);
  assert.equal(isPriceHistorySymbol("CAR   260618P00390000"), false);
  assert.equal(isPriceHistorySymbol(""), false);
  assert.equal(isPriceHistorySymbol("NOPE!"), false);
});

test("candleSessionDate buckets Schwab epochs onto the ET calendar", () => {
  // Midnight EDT (UTC−4) on 2026-08-03.
  assert.equal(candleSessionDate(Date.parse("2026-08-03T04:00:00.000Z")), "2026-08-03");
  // Regular session close 4pm ET.
  assert.equal(candleSessionDate(Date.parse("2026-08-03T20:00:00.000Z")), "2026-08-03");
});

test("normalizeSchwabPriceHistory keeps previousClose as a prior bar", () => {
  const bars = normalizeSchwabPriceHistory({
    symbol: "TLT",
    empty: false,
    previousClose: 88.1,
    previousCloseDate: Date.parse("2026-07-31T16:00:00.000Z"),
    candles: [
      {
        open: 87,
        high: 88,
        low: 86,
        close: 87.26,
        volume: 1_000,
        datetime: Date.parse("2026-08-03T20:00:00.000Z"),
      },
    ],
  });
  assert.equal(bars.length, 2);
  assert.equal(bars[0]!.date, "2026-07-31");
  assert.equal(bars[0]!.close, 88.1);
  assert.equal(bars[1]!.date, "2026-08-03");
  assert.equal(bars[1]!.close, 87.26);
  assert.equal(bars[1]!.open, 87);
});

test("normalizeSchwabPriceHistory ignores empty or malformed payloads", () => {
  assert.deepEqual(normalizeSchwabPriceHistory(null), []);
  assert.deepEqual(normalizeSchwabPriceHistory({ empty: true, candles: [] }), []);
  assert.deepEqual(
    normalizeSchwabPriceHistory({ candles: [{ datetime: "nope", close: 10 }] }),
    [],
  );
});

test("fetchSchwabPriceHistory uses the connected token and daily candles", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("Authorization") });
    return new Response(
      JSON.stringify({
        symbol: "TLT",
        empty: false,
        candles: [
          {
            open: 87,
            high: 88,
            low: 86,
            close: 87.26,
            volume: 1000,
            datetime: Date.parse("2026-08-03T20:00:00.000Z"),
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const bars = await fetchSchwabPriceHistory(
    "tok-1",
    { symbol: "tlt", start: "2026-08-01", end: "2026-08-29" },
    "Bearer",
    fetchImpl,
  );
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(`${url.origin}${url.pathname}`, `${SCHWAB_MARKETDATA_BASE}/pricehistory`);
  assert.equal(url.searchParams.get("symbol"), "TLT");
  assert.equal(url.searchParams.get("periodType"), "year");
  assert.equal(url.searchParams.get("frequencyType"), "daily");
  assert.equal(url.searchParams.get("needPreviousClose"), "true");
  assert.equal(calls[0]!.auth, "Bearer tok-1");
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.close, 87.26);

  const skipped = await fetchSchwabPriceHistory(
    "tok-1",
    { symbol: "CAR   260618P00390000", start: "2026-08-01", end: "2026-08-29" },
    "Bearer",
    fetchImpl,
  );
  assert.deepEqual(skipped, []);
  assert.equal(calls.length, 1);
});

test("fetchSchwabPriceHistory throws SchwabApiError on failure", async () => {
  const fetchImpl: typeof fetch = async () => new Response("nope", { status: 401 });
  await assert.rejects(
    () => fetchSchwabPriceHistory("bad", { symbol: "TLT", start: "2026-08-01", end: "2026-08-29" }, "Bearer", fetchImpl),
    (err: unknown) => err instanceof SchwabApiError && err.status === 401,
  );
});
