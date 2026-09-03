import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHWAB_MARKETDATA_BASE,
  SCHWAB_QUOTES_MAX,
  candleSessionDate,
  fetchSchwabDividendYield,
  fetchSchwabPriceHistory,
  fetchSchwabQuotes,
  formatSchwabQuotesSummary,
  isPriceHistorySymbol,
  isQuoteSymbol,
  loadSchwabQuotesForUser,
  normalizeSchwabDividendYield,
  normalizeSchwabPriceHistory,
  normalizeSchwabQuotes,
  priceHistoryLookbackStart,
  sanitizeQuoteSymbols,
} from "../src/schwab-marketdata.ts";
import { SchwabApiError } from "../src/schwab-portfolio.ts";
import { COPILOT_TOOL_INPUT_SCHEMAS } from "../src/copilot-contract.ts";
import type { SchwabEnv } from "../src/schwab.ts";

test("priceHistoryLookbackStart pads 21 calendar days before the chart", () => {
  assert.equal(priceHistoryLookbackStart("2026-08-01"), "2026-07-11");
});

test("isPriceHistorySymbol allows equity roots and OCC option symbols", () => {
  assert.equal(isPriceHistorySymbol("TLT"), true);
  assert.equal(isPriceHistorySymbol("BRK/B"), true);
  assert.equal(isPriceHistorySymbol("BRK.B"), true);
  assert.equal(isPriceHistorySymbol("CAR   260618P00390000"), true);
  assert.equal(isPriceHistorySymbol("CAR260618P00390000"), true);
  assert.equal(isPriceHistorySymbol("NOT AN OPTION"), false);
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
    { symbol: "NOPE!", start: "2026-08-01", end: "2026-08-29" },
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

test("normalizeSchwabDividendYield accepts percent or annual dividend amount", () => {
  assert.equal(
    normalizeSchwabDividendYield(
      { TLT: { fundamental: { divYield: 4.25 } } },
      "TLT",
    ),
    0.0425,
  );
  assert.equal(
    normalizeSchwabDividendYield(
      { TLT: { fundamental: { divAmount: 4 }, quote: { lastPrice: 100 } } },
      "TLT",
    ),
    0.04,
  );
});

test("fetchSchwabDividendYield requests quote fundamentals", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({ TLT: { fundamental: { divYield: 4.5 } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  assert.equal(await fetchSchwabDividendYield("tok", "tlt", "Bearer", fetchImpl), 0.045);
  const url = new URL(calls[0]!);
  assert.equal(url.pathname, "/marketdata/v1/quotes");
  assert.equal(url.searchParams.get("symbols"), "TLT");
  assert.equal(url.searchParams.get("fields"), "fundamental");
});

test("isQuoteSymbol allows equities, indexes, futures, and OCC options", () => {
  assert.equal(isQuoteSymbol("AAPL"), true);
  assert.equal(isQuoteSymbol("$SPX"), true);
  assert.equal(isQuoteSymbol("/ES"), true);
  assert.equal(isQuoteSymbol("BRK/B"), true);
  assert.equal(isQuoteSymbol("CAR260618P00390000"), true);
  assert.equal(isQuoteSymbol("NOPE!"), false);
  assert.equal(isQuoteSymbol(""), false);
});

test("sanitizeQuoteSymbols uppercases, uniques, caps, and drops junk", () => {
  assert.deepEqual(
    sanitizeQuoteSymbols(["aapl", "AAPL", "$spx", "nope!", 12, "MSFT"]),
    ["AAPL", "$SPX", "MSFT"],
  );
  const many = Array.from({ length: SCHWAB_QUOTES_MAX + 5 }, (_, i) => `T${i}`);
  assert.equal(sanitizeQuoteSymbols(many).length, SCHWAB_QUOTES_MAX);
});

test("get_schwab_quotes schema accepts symbols only — never a user id", () => {
  assert.deepEqual(
    COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_quotes.parse({ symbols: ["AAPL", "MSFT"] }),
    { symbols: ["AAPL", "MSFT"] },
  );
  assert.throws(() =>
    COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_quotes.parse({
      symbols: ["AAPL"],
      user_id: "someone-else",
    }),
  );
  assert.throws(() =>
    COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_quotes.parse({
      symbols: ["AAPL"],
      access_token: "tok",
    }),
  );
});

test("normalizeSchwabQuotes reads last/bid/ask/mark from a keyed payload", () => {
  const quotes = normalizeSchwabQuotes({
    AAPL: {
      symbol: "AAPL",
      delayed: false,
      reference: { description: "Apple Inc", assetMainType: "EQUITY" },
      quote: {
        lastPrice: 227.5,
        bidPrice: 227.48,
        askPrice: 227.52,
        mark: 227.5,
        closePrice: 226,
        netChange: 1.5,
        netPercentChangeInDouble: 0.6637,
        totalVolume: 12_000_000,
        quoteTime: Date.parse("2026-09-02T20:00:00.000Z"),
      },
    },
  }, ["AAPL"]);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0]!.symbol, "AAPL");
  assert.equal(quotes[0]!.last, 227.5);
  assert.equal(quotes[0]!.bid, 227.48);
  assert.equal(quotes[0]!.ask, 227.52);
  assert.equal(quotes[0]!.delayed, false);
  assert.equal(quotes[0]!.description, "Apple Inc");
  assert.equal(quotes[0]!.asset_type, "EQUITY");
  assert.match(formatSchwabQuotesSummary(quotes), /AAPL/);
  assert.match(formatSchwabQuotesSummary(quotes), /equity/);
  assert.match(formatSchwabQuotesSummary(quotes), /Apple Inc/);
  assert.match(formatSchwabQuotesSummary(quotes), /227\.5/);
});

test("fetchSchwabQuotes uses the provided token and symbol list", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get("Authorization") });
    return new Response(
      JSON.stringify({
        AAPL: { symbol: "AAPL", quote: { lastPrice: 10, bidPrice: 9.9, askPrice: 10.1 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const quotes = await fetchSchwabQuotes("tok-owner", ["aapl"], "Bearer", fetchImpl);
  assert.equal(quotes[0]!.last, 10);
  assert.equal(calls[0]!.auth, "Bearer tok-owner");
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/marketdata/v1/quotes");
  assert.equal(url.searchParams.get("symbols"), "AAPL");
  assert.equal(url.searchParams.get("fields"), "quote,reference");
});

function fakeSchwabEnv(rows: Record<string, string>, queried: string[]): SchwabEnv {
  return {
    SCHEMA_DB: {
      prepare() {
        return {
          bind(userId: string) {
            queried.push(userId);
            return {
              first: async () => {
                const token = rows[userId];
                if (!token) return null;
                return {
                  user_id: userId,
                  access_token: token,
                  refresh_token: `refresh-${userId}`,
                  token_type: "Bearer",
                  scope: "api",
                  expires_at: Date.now() + 60 * 60 * 1000,
                  connected_at: 1,
                  updated_at: 1,
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    SCHWAB_CLIENT_ID: "id",
    SCHWAB_CLIENT_SECRET: "secret",
  };
}

test("loadSchwabQuotesForUser uses only the requested user's token", async () => {
  const auths: string[] = [];
  const queried: string[] = [];
  const env = fakeSchwabEnv({ "user-a": "tok-a", "user-b": "tok-b" }, queried);

  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    auths.push(headers.get("Authorization") ?? "");
    return new Response(
      JSON.stringify({
        AAPL: { symbol: "AAPL", quote: { lastPrice: 1, bidPrice: 1, askPrice: 1 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const a = await loadSchwabQuotesForUser(env, "user-a", ["AAPL"], fetchImpl);
  assert.equal(a.ok, true);
  assert.deepEqual(queried, ["user-a"]);
  assert.deepEqual(auths, ["Bearer tok-a"]);

  queried.length = 0;
  auths.length = 0;
  const b = await loadSchwabQuotesForUser(env, "user-b", ["AAPL"], fetchImpl);
  assert.equal(b.ok, true);
  assert.deepEqual(queried, ["user-b"]);
  assert.deepEqual(auths, ["Bearer tok-b"]);

  queried.length = 0;
  auths.length = 0;
  const none = await loadSchwabQuotesForUser(env, "user-c", ["AAPL"], fetchImpl);
  assert.deepEqual(none, { ok: false, reason: "not_connected" });
  assert.deepEqual(queried, ["user-c"]);
  assert.deepEqual(auths, []);
});
