import assert from "node:assert/strict";
import test from "node:test";
import {
  attachCashSleeves,
  buildPnlFills,
  buildRealizedPnlLedger,
  aliasesForTicker,
  distributionMatchesTicker,
  fetchWindowForPnl,
  optionSymbolsForPriceHistory,
  padOccSymbolForPriceHistory,
  normalizeSchwabDistribution,
  openMarkForTicker,
  parseOccOptionSymbol,
  resolvePnlRange,
  seriesFromLedger,
  synthesizeOptionAssignmentCloses,
  SCHWAB_PNL_RANGES,
} from "../src/schwab-pnl.ts";
import { matchesTicker } from "../src/schwab-trader.ts";
import type { SchwabTrade } from "../src/schwab-trader.ts";
import { SCHWAB_TRADES_MAX_RANGE_DAYS } from "../src/schwab-trader.ts";

function trade(partial: Partial<SchwabTrade> & Pick<SchwabTrade, "id" | "trade_date" | "side">): SchwabTrade {
  return {
    activity_id: null,
    settlement_date: null,
    description: null,
    status: "VALID",
    activity_type: "EXECUTION",
    net_amount: null,
    symbol: "AAPL",
    underlying: null,
    asset_type: "EQUITY",
    quantity: null,
    price: null,
    cost: null,
    fees: null,
    position_effect: null,
    order_id: null,
    position_id: null,
    cusip: null,
    ...partial,
  };
}

function daySum(ledger: ReturnType<typeof buildRealizedPnlLedger>, day: string): number {
  return ledger.events.filter((e) => e.day === day).reduce((s, e) => s + e.amount, 0);
}

test("resolvePnlRange accepts presets and defaults to YTD", () => {
  const now = new Date("2026-08-28T16:00:00.000Z");
  const ytd = resolvePnlRange(null, now);
  assert.ok(!("error" in ytd));
  if ("error" in ytd) return;
  assert.equal(ytd.range, "YTD");
  assert.equal(ytd.start, "2026-01-01");
  assert.equal(ytd.end, "2026-08-28");

  const mtd = resolvePnlRange("mtd", now);
  assert.ok(!("error" in mtd));
  if ("error" in mtd) return;
  assert.equal(mtd.range, "MTD");
  assert.equal(mtd.start, "2026-08-01");

  const oneY = resolvePnlRange("1Y", now);
  assert.ok(!("error" in oneY));
  if ("error" in oneY) return;
  assert.equal(oneY.range, "1Y");
  assert.equal(oneY.start, "2025-08-29");

  assert.ok("error" in resolvePnlRange("ALL", now));
  assert.deepEqual(SCHWAB_PNL_RANGES, ["MTD", "YTD", "1M", "3M", "6M", "1Y"]);
});

test("fetchWindowForPnl extends to Schwab max lookback for basis", () => {
  const w = fetchWindowForPnl("2026-08-01", "2026-08-28");
  assert.equal(w.end, "2026-08-28");
  const endMs = Date.parse("2026-08-28T00:00:00.000Z");
  const expectedStart = new Date(
    endMs - (365 - 1) * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);
  assert.equal(w.start, expectedStart);
  assert.ok(expectedStart >= new Date(
    endMs - (SCHWAB_TRADES_MAX_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10));
});

test("FIFO long round-trip realizes proceeds − basis", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-10T15:00:00.000Z",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-02-10T15:00:00.000Z",
      side: "sell",
      quantity: 10,
      net_amount: 1150,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(daySum(ledger, "2026-02-10"), 150);
  assert.equal(ledger.closingTradeCount, 1);
  assert.equal(ledger.unmatchedCloseCount, 0);

  const { points, summary } = seriesFromLedger(ledger, "2026-01-01", "2026-03-01");
  assert.equal(summary.period_pnl, 150);
  assert.equal(summary.prior_open_pnl, 0);
  assert.equal(points[0]!.cumulative_pnl, 0);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 150);
});

test("FIFO short cover realizes short proceeds − buyback", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-03-01T15:00:00.000Z",
      side: "sell",
      quantity: 5,
      net_amount: 500,
      position_effect: "OPENING",
      symbol: "MSFT",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-03-15T15:00:00.000Z",
      side: "buy",
      quantity: 5,
      net_amount: -450,
      position_effect: "CLOSING",
      symbol: "MSFT",
    }),
  ]);
  assert.equal(daySum(ledger, "2026-03-15"), 50);
});

test("partial FIFO close realizes pro-rata", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-05",
      side: "buy",
      quantity: 100,
      net_amount: -10000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-01-20",
      side: "sell",
      quantity: 40,
      net_amount: 4800,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(daySum(ledger, "2026-01-20"), 800);
});

test("CLOSING without in-window open is unmatched (no phantom PnL)", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-06-01",
      side: "sell",
      quantity: 10,
      net_amount: 2000,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(ledger.unmatchedCloseCount, 1);
  assert.equal(ledger.events.length, 0);
});

test("seriesFromLedger only accumulates chart-window days", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2025-12-01",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2025-12-15",
      side: "sell",
      quantity: 10,
      net_amount: 1100,
      position_effect: "CLOSING",
    }),
    trade({
      id: "3",
      activity_id: 3,
      trade_date: "2026-02-01",
      side: "buy",
      quantity: 10,
      net_amount: -500,
      position_effect: "OPENING",
      symbol: "XYZ",
    }),
    trade({
      id: "4",
      activity_id: 4,
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 700,
      position_effect: "CLOSING",
      symbol: "XYZ",
    }),
  ]);
  const { summary, points } = seriesFromLedger(ledger, "2026-01-01", "2026-02-28");
  assert.equal(summary.period_pnl, 200);
  assert.equal(summary.prior_open_pnl, 0);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 200);
});

test("closes of lots opened before the period are excluded from period_pnl", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-07-15",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
      symbol: "SVIX",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-08-03",
      side: "sell",
      quantity: 10,
      net_amount: 700,
      position_effect: "CLOSING",
      symbol: "SVIX",
    }),
    trade({
      id: "3",
      activity_id: 3,
      trade_date: "2026-08-05",
      side: "buy",
      quantity: 5,
      net_amount: -200,
      position_effect: "OPENING",
      symbol: "LOFD",
    }),
    trade({
      id: "4",
      activity_id: 4,
      trade_date: "2026-08-10",
      side: "sell",
      quantity: 5,
      net_amount: 250,
      position_effect: "CLOSING",
      symbol: "LOFD",
    }),
  ]);
  // SVIX: opened July, closed Aug → −300 prior; LOFD: open+close in Aug → +50 period
  const { summary, points } = seriesFromLedger(ledger, "2026-08-01", "2026-08-31");
  assert.equal(summary.period_pnl, 50);
  assert.equal(summary.prior_open_pnl, -300);
  assert.equal(points[points.length - 1]!.cumulative_pnl, 50);

  const fills = buildPnlFills(ledger, "2026-08-01", "2026-08-31");
  assert.equal(fills.length, 2);
  const lofd = fills.find((f) => f.symbol === "LOFD");
  const svix = fills.find((f) => f.symbol === "SVIX");
  assert.ok(lofd);
  assert.ok(svix);
  assert.equal(lofd!.realized_pnl, 50);
  assert.equal(lofd!.prior_open, false);
  assert.equal(svix!.realized_pnl, -300);
  assert.equal(svix!.prior_open, true);
});

test("normalizeSchwabDistribution sums currency legs", () => {
  const d = normalizeSchwabDistribution({
    activityId: 99,
    time: "2026-03-15T12:00:00.000Z",
    description: "Ordinary Dividend",
    type: "DIVIDEND_OR_INTEREST",
    status: "VALID",
    netAmount: 12.5,
    transferItems: [
      {
        instrument: { assetType: "EQUITY", symbol: "VTI", description: "VANGUARD TOTAL STOCK" },
        amount: 0,
      },
      {
        instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" },
        amount: 12.5,
      },
    ],
  });
  assert.ok(d);
  assert.equal(d!.date, "2026-03-15");
  assert.equal(d!.symbol, "VTI");
  assert.equal(d!.amount, 12.5);
  assert.equal(d!.id, "dist-99");
  assert.equal(d!.cusip, null);
});

test("normalizeSchwabDistribution keeps CUSIP when ETF dividend omits symbol", () => {
  const d = normalizeSchwabDistribution({
    activityId: 7,
    time: "2026-08-06T04:00:00.000Z",
    description: "ISHARES 20+ YEAR TREASURY BOND ETF",
    type: "DIVIDEND_OR_INTEREST",
    status: "VALID",
    netAmount: 33.05,
    transferItems: [
      {
        instrument: {
          assetType: "COLLECTIVE_INVESTMENT",
          cusip: "464287432",
          description: "ISHARES 20+ YEAR TREASURY BOND ETF",
        },
        amount: 0,
      },
      {
        instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" },
        amount: 33.05,
      },
    ],
  });
  assert.ok(d);
  assert.equal(d!.symbol, null);
  assert.equal(d!.cusip, "464287432");
  assert.equal(d!.amount, 33.05);
});

test("buildPnlFills includes fees from the closing trade", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-01-10",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      fees: 1,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 1145,
      fees: 5,
      price: 115,
      position_effect: "CLOSING",
    }),
  ]);
  const fills = buildPnlFills(ledger, "2026-01-01", "2026-03-01");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]!.fees, 5);
  assert.equal(fills[0]!.realized_pnl, 145);
  assert.equal(fills[0]!.quantity, 10);
});

test("parseOccOptionSymbol reads root right strike", () => {
  const p = parseOccOptionSymbol("CAR   260618P00390000");
  assert.ok(p);
  assert.equal(p!.underlying, "CAR");
  assert.equal(p!.right, "P");
  assert.equal(p!.strike, 390);
  assert.equal(parseOccOptionSymbol("AAPL") , null);

  const readable = parseOccOptionSymbol("CAR 2026-06-18 P 390");
  assert.ok(readable);
  assert.equal(readable!.underlying, "CAR");
  assert.equal(readable!.expiration, "260618");
  assert.equal(readable!.right, "P");
  assert.equal(readable!.strike, 390);
});

test("short put assignment synthesizes zero-cash cover before stock delivery", () => {
  // Debit put spread: long 500 / short 390, then short assigned + long closed.
  const trades = [
    trade({
      id: "117236520805",
      activity_id: 117236520805,
      trade_date: "2026-04-22T16:12:19+0000",
      side: "buy",
      symbol: "CAR   260618P00500000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      price: 142.6,
      net_amount: -14260.66,
      fees: 0.66,
      position_effect: "OPENING",
    }),
    trade({
      id: "117236520806",
      activity_id: 117236520806,
      trade_date: "2026-04-22T16:12:19+0000",
      side: "sell",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: -1,
      price: 83.1,
      net_amount: 8309.17,
      fees: 0.83,
      position_effect: "OPENING",
    }),
    trade({
      id: "118595999427",
      activity_id: 118595999427,
      trade_date: "2026-05-08T04:00:00+0000",
      side: "buy",
      symbol: "CAR",
      asset_type: "EQUITY",
      quantity: 100,
      price: 390,
      net_amount: -39000,
      position_effect: "OPENING",
      description: "AVIS BUDGET GROUP INC",
    }),
    trade({
      id: "118647308762",
      activity_id: 118647308762,
      trade_date: "2026-05-08T04:00:00+0000",
      side: "sell",
      symbol: "CAR   260618P00500000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: -1,
      price: 354.6,
      net_amount: 35458.61,
      fees: 1.39,
      position_effect: "CLOSING",
    }),
    trade({
      id: "118647309307",
      activity_id: 118647309307,
      trade_date: "2026-05-08T15:14:53+0000",
      side: "sell",
      symbol: "CAR",
      asset_type: "EQUITY",
      quantity: -100,
      price: 145.14,
      net_amount: 14513.68,
      fees: 0.32,
      position_effect: "CLOSING",
    }),
  ];

  const withSynth = synthesizeOptionAssignmentCloses(trades);
  const synth = withSynth.find((t) => t.id.startsWith("synth-assign-"));
  assert.ok(synth);
  assert.equal(synth!.symbol, "CAR   260618P00390000");
  assert.equal(synth!.side, "buy");
  assert.equal(synth!.net_amount, 0);
  assert.equal(synth!.position_effect, "CLOSING");

  const ledger = buildRealizedPnlLedger(trades);
  const { summary } = seriesFromLedger(ledger, "2026-01-01", "2026-05-31");
  // Long 500 close ≈ +21197.95; short 390 assign cover ≈ +8309.17; stock ≈ -24486.32
  // Net ≈ +5020.8 (width of spread minus debit), not the bogus −3288 without synth.
  assert.ok(summary.period_pnl > 4900 && summary.period_pnl < 5200, `got ${summary.period_pnl}`);

  const may8 = ledger.events.filter((e) => e.day === "2026-05-08").reduce((s, e) => s + e.amount, 0);
  assert.ok(may8 > 4900 && may8 < 5200, `may8 ${may8}`);

  const fills = buildPnlFills(ledger, "2026-05-01", "2026-05-10");
  const shortPut = fills.find((f) => f.symbol === "CAR   260618P00390000");
  assert.ok(shortPut);
  assert.ok((shortPut!.realized_pnl ?? 0) > 8200);
});

test("readable option symbols still match FIFO lots and assignment synth", () => {
  const trades = [
    trade({
      id: "open",
      activity_id: 1,
      trade_date: "2026-04-01T15:00:00.000Z",
      side: "sell",
      symbol: "CAR 2026-06-18 P 390",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 800,
      position_effect: "OPENING",
    }),
    trade({
      id: "stock",
      activity_id: 2,
      trade_date: "2026-05-08T04:00:00.000Z",
      side: "buy",
      symbol: "CAR",
      asset_type: "EQUITY",
      quantity: 100,
      price: 390,
      net_amount: -39000,
      position_effect: "OPENING",
      description: "AVIS BUDGET GROUP INC",
    }),
  ];
  const synth = synthesizeOptionAssignmentCloses(trades).find((t) =>
    t.id.startsWith("synth-assign-"),
  );
  assert.ok(synth);
  assert.equal(synth!.symbol, "CAR 2026-06-18 P 390");

  // Mixed readable open + OCC cover still share a lot book.
  const ledger = buildRealizedPnlLedger([
    trades[0]!,
    trade({
      id: "cover",
      activity_id: 3,
      trade_date: "2026-05-09T15:00:00.000Z",
      side: "buy",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: -100,
      position_effect: "CLOSING",
    }),
  ]);
  assert.equal(ledger.unmatchedCloseCount, 0);
  assert.ok(daySum(ledger, "2026-05-09") > 0);
});

test("short call assignment synthesizes zero-cash cover before stock delivery", () => {
  const trades = [
    trade({
      id: "short-call",
      activity_id: 1,
      trade_date: "2026-03-01T15:00:00.000Z",
      side: "sell",
      symbol: "AAPL  260417C00150000",
      underlying: "AAPL",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 350,
      position_effect: "OPENING",
    }),
    trade({
      id: "deliver",
      activity_id: 2,
      trade_date: "2026-04-17T04:00:00.000Z",
      side: "sell",
      symbol: "AAPL",
      asset_type: "EQUITY",
      quantity: 100,
      price: 150,
      net_amount: 15000,
      position_effect: "OPENING",
      description: "APPLE INC",
    }),
  ];
  const withSynth = synthesizeOptionAssignmentCloses(trades);
  const synth = withSynth.find((t) => t.id.startsWith("synth-assign-"));
  assert.ok(synth);
  assert.equal(synth!.symbol, "AAPL  260417C00150000");
  assert.equal(synth!.side, "buy");
  assert.equal(synth!.net_amount, 0);

  const ledger = buildRealizedPnlLedger(trades);
  const { summary } = seriesFromLedger(ledger, "2026-01-01", "2026-04-30");
  // Short premium realized (+350) + stock short opened (no close yet) = +350
  assert.equal(summary.period_pnl, 350);
});

test("ordinary BOUGHT fill at strike does not synthesize assignment cover", () => {
  const trades = [
    trade({
      id: "short-put",
      activity_id: 1,
      trade_date: "2026-04-01T15:00:00.000Z",
      side: "sell",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 800,
      position_effect: "OPENING",
    }),
    trade({
      id: "voluntary-buy",
      activity_id: 2,
      trade_date: "2026-05-08T15:00:00.000Z",
      side: "buy",
      symbol: "CAR",
      asset_type: "EQUITY",
      quantity: 100,
      price: 390,
      net_amount: -39000,
      position_effect: "OPENING",
      description: "BOUGHT 100 CAR @ 390",
    }),
  ];
  const withSynth = synthesizeOptionAssignmentCloses(trades);
  assert.equal(
    withSynth.filter((t) => t.id.startsWith("synth-assign-")).length,
    0,
  );
});

test("CLOSING equity at strike does not synthesize assignment cover", () => {
  const trades = [
    trade({
      id: "short-call",
      activity_id: 1,
      trade_date: "2026-03-01T15:00:00.000Z",
      side: "sell",
      symbol: "AAPL  260417C00150000",
      underlying: "AAPL",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 350,
      position_effect: "OPENING",
    }),
    trade({
      id: "sell-to-close-stock",
      activity_id: 2,
      trade_date: "2026-04-10T15:00:00.000Z",
      side: "sell",
      symbol: "AAPL",
      asset_type: "EQUITY",
      quantity: 100,
      price: 150,
      net_amount: 15000,
      position_effect: "CLOSING",
      description: "APPLE INC",
    }),
  ];
  assert.equal(
    synthesizeOptionAssignmentCloses(trades).filter((t) => t.id.startsWith("synth-assign-"))
      .length,
    0,
  );
});

test("after-hours close stays on the ET session date for period attribution", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      activity_id: 1,
      trade_date: "2026-08-03T14:00:00.000Z",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
    }),
    trade({
      id: "2",
      activity_id: 2,
      // 9:30pm ET Aug 28 → UTC Aug 29; must still count as Aug 28 ET.
      trade_date: "2026-08-29T01:30:00.000Z",
      side: "sell",
      quantity: 10,
      net_amount: 1200,
      position_effect: "CLOSING",
    }),
  ]);
  const { summary } = seriesFromLedger(ledger, "2026-08-01", "2026-08-28");
  assert.equal(summary.period_pnl, 200);
  assert.equal(summary.closing_trade_count, 1);
  const outside = seriesFromLedger(ledger, "2026-08-29", "2026-08-31");
  assert.equal(outside.summary.period_pnl, 0);
});

test("assignment synth prefers the short expiry closest to the delivery day", () => {
  const trades = [
    trade({
      id: "far-short",
      activity_id: 1,
      trade_date: "2026-03-01T15:00:00.000Z",
      side: "sell",
      symbol: "CAR   260918P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 400,
      position_effect: "OPENING",
    }),
    trade({
      id: "near-short",
      activity_id: 2,
      trade_date: "2026-04-01T15:00:00.000Z",
      side: "sell",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 800,
      position_effect: "OPENING",
    }),
    trade({
      id: "assign",
      activity_id: 3,
      trade_date: "2026-05-08T04:00:00+0000",
      side: "buy",
      symbol: "CAR",
      asset_type: "EQUITY",
      quantity: 100,
      price: 390,
      net_amount: -39000,
      position_effect: "OPENING",
      description: "AVIS BUDGET GROUP INC",
    }),
  ];
  const synth = synthesizeOptionAssignmentCloses(trades).filter((t) =>
    t.id.startsWith("synth-assign-"),
  );
  assert.equal(synth.length, 1);
  assert.equal(synth[0]!.symbol, "CAR   260618P00390000");
});

test("seriesFromLedger scopes skipped_trade_count to the chart window", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "old-skip",
      activity_id: 1,
      trade_date: "2025-12-15",
      side: "unknown",
      quantity: 10,
      net_amount: 100,
      symbol: "OLD",
    }),
    trade({
      id: "new-skip",
      activity_id: 2,
      trade_date: "2026-02-10",
      side: "unknown",
      quantity: 5,
      net_amount: 50,
      symbol: "NEW",
    }),
    trade({
      id: "ok",
      activity_id: 3,
      trade_date: "2026-02-11",
      side: "buy",
      quantity: 1,
      net_amount: -10,
      position_effect: "OPENING",
      symbol: "OK",
    }),
  ]);
  assert.equal(ledger.skippedTradeCount, 2);
  const { summary } = seriesFromLedger(ledger, "2026-01-01", "2026-02-28");
  assert.equal(summary.skipped_trade_count, 1);
  const outside = seriesFromLedger(ledger, "2026-03-01", "2026-03-31");
  assert.equal(outside.summary.skipped_trade_count, 0);
});

test("seriesFromLedger scopes unmatched_close_count to the chart window", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "old-orphan",
      activity_id: 1,
      trade_date: "2025-12-15",
      side: "sell",
      quantity: 10,
      net_amount: 1000,
      position_effect: "CLOSING",
      symbol: "OLD",
    }),
    trade({
      id: "new-orphan",
      activity_id: 2,
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 5,
      net_amount: 500,
      position_effect: "CLOSING",
      symbol: "NEW",
    }),
  ]);
  assert.equal(ledger.unmatchedCloseCount, 2);
  const { summary } = seriesFromLedger(ledger, "2026-01-01", "2026-02-28");
  assert.equal(summary.unmatched_close_count, 1);
  const outside = seriesFromLedger(ledger, "2026-03-01", "2026-03-31");
  assert.equal(outside.summary.unmatched_close_count, 0);
});

test("seriesFromLedger splits equity vs option realized sleeves", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "eq-open",
      trade_date: "2026-01-10",
      side: "buy",
      quantity: 10,
      net_amount: -1000,
      position_effect: "OPENING",
      symbol: "CAR",
    }),
    trade({
      id: "eq-close",
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 1150,
      position_effect: "CLOSING",
      symbol: "CAR",
    }),
    trade({
      id: "opt-open",
      trade_date: "2026-01-12",
      side: "sell",
      quantity: 1,
      net_amount: 250,
      position_effect: "OPENING",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
    }),
    trade({
      id: "opt-close",
      trade_date: "2026-02-12",
      side: "buy",
      quantity: 1,
      net_amount: -100,
      position_effect: "CLOSING",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
    }),
  ]);
  const { points, summary } = seriesFromLedger(ledger, "2026-01-01", "2026-03-01");
  assert.equal(summary.period_pnl, 300);
  const eqClose = points.find((p) => p.date === "2026-02-10");
  const optClose = points.find((p) => p.date === "2026-02-12");
  assert.equal(eqClose?.daily_equity_pnl, 150);
  assert.equal(eqClose?.daily_option_pnl, 0);
  assert.equal(optClose?.daily_option_pnl, 150);
  assert.equal(optClose?.daily_equity_pnl, 0);
});

test("attachCashSleeves stamps fees and dividends without changing trading PnL", () => {
  const ledger = buildRealizedPnlLedger([
    trade({
      id: "1",
      trade_date: "2026-01-10",
      side: "buy",
      quantity: 10,
      net_amount: -1001,
      fees: -1,
      position_effect: "OPENING",
      symbol: "CAR",
    }),
    trade({
      id: "2",
      trade_date: "2026-02-10",
      side: "sell",
      quantity: 10,
      net_amount: 1149,
      fees: -1,
      position_effect: "CLOSING",
      symbol: "CAR",
    }),
  ]);
  const { points } = seriesFromLedger(ledger, "2026-01-01", "2026-03-01");
  const stamped = attachCashSleeves(
    points,
    [
      trade({
        id: "1",
        trade_date: "2026-01-10",
        side: "buy",
        quantity: 10,
        net_amount: -1001,
        fees: -1,
        symbol: "CAR",
      }),
      trade({
        id: "2",
        trade_date: "2026-02-10",
        side: "sell",
        quantity: 10,
        net_amount: 1149,
        fees: -1,
        symbol: "CAR",
      }),
    ],
    [{
      id: "d1",
      date: "2026-02-05",
      symbol: "CAR",
      description: "Qualified dividend",
      amount: 12.5,
      type: "DIVIDEND_OR_INTEREST",
      status: "VALID",
      cusip: null,
    }],
    "2026-01-01",
    "2026-03-01",
  );
  assert.equal(stamped.find((p) => p.date === "2026-01-10")?.daily_equity_fees, -1);
  assert.equal(stamped.find((p) => p.date === "2026-02-10")?.daily_fees, -1);
  assert.equal(stamped.find((p) => p.date === "2026-02-05")?.daily_dividends, 12.5);
  assert.equal(stamped.at(-1)?.cumulative_pnl, 148);
});

test("attachCashSleeves coerces live positive Schwab fees to commission drag", () => {
  const stamped = attachCashSleeves(
    [emptyish("2026-05-08")],
    [
      trade({
        id: "stock-sale",
        trade_date: "2026-05-08",
        side: "sell",
        symbol: "CAR",
        quantity: -100,
        net_amount: 14513.68,
        fees: 0.32,
        position_effect: "CLOSING",
      }),
      trade({
        id: "put-close",
        trade_date: "2026-05-08",
        side: "sell",
        symbol: "CAR   260618P00500000",
        underlying: "CAR",
        asset_type: "OPTION",
        quantity: -1,
        net_amount: 35458.61,
        fees: 1.39,
        position_effect: "CLOSING",
      }),
    ],
    [],
    "2026-05-01",
    "2026-05-10",
  );
  const day = stamped.find((p) => p.date === "2026-05-08");
  assert.equal(day?.daily_fees, -1.71);
  assert.equal(day?.daily_equity_fees, -0.32);
  assert.equal(day?.daily_option_fees, -1.39);
});

function emptyish(date: string) {
  return {
    date,
    daily_pnl: 0,
    cumulative_pnl: 0,
    daily_equity_pnl: 0,
    daily_option_pnl: 0,
    daily_fees: 0,
    daily_equity_fees: 0,
    daily_option_fees: 0,
    daily_dividends: 0,
  };
}

test("optionSymbolsForPriceHistory keeps unique OCC roots and ignores equity", () => {
  const symbols = optionSymbolsForPriceHistory([
    trade({ id: "1", trade_date: "2026-04-01", side: "sell", symbol: "CAR   260618P00390000", asset_type: "OPTION" }),
    trade({ id: "2", trade_date: "2026-04-01", side: "buy", symbol: "CAR   260618P00500000", asset_type: "OPTION" }),
    trade({ id: "3", trade_date: "2026-05-08", side: "sell", symbol: "CAR", asset_type: "EQUITY" }),
    trade({ id: "4", trade_date: "2026-05-08", side: "buy", symbol: "CAR   260618P00390000", asset_type: "OPTION" }),
  ]);
  assert.equal(symbols.size, 2);
  assert.ok(symbols.has("CAR260618P00390000"));
  assert.ok(symbols.has("CAR260618P00500000"));
  // Schwab /pricehistory wants the 21-char padded OCC print.
  assert.equal(symbols.get("CAR260618P00390000"), "CAR   260618P00390000");
  assert.equal(symbols.get("CAR260618P00500000"), "CAR   260618P00500000");
});

test("padOccSymbolForPriceHistory pads compact roots to 6 characters", () => {
  assert.equal(padOccSymbolForPriceHistory("CAR260618P00390000"), "CAR   260618P00390000");
  assert.equal(padOccSymbolForPriceHistory("CAR   260618P00390000"), "CAR   260618P00390000");
  assert.equal(padOccSymbolForPriceHistory("AAPL260918C00200000"), "AAPL  260918C00200000");
  assert.equal(padOccSymbolForPriceHistory("CAR"), null);
});

test("ticker filter keeps CAR stock and CAR options, drops CARD", () => {
  const rows = [
    trade({ id: "1", trade_date: "2026-01-01", side: "buy", symbol: "CAR", quantity: 1, net_amount: -10 }),
    trade({
      id: "2",
      trade_date: "2026-01-02",
      side: "sell",
      symbol: "CAR   260618P00390000",
      underlying: "CAR",
      asset_type: "OPTION",
      quantity: 1,
      net_amount: 20,
    }),
    trade({ id: "3", trade_date: "2026-01-03", side: "buy", symbol: "CARD", quantity: 1, net_amount: -5 }),
  ].filter((t) => matchesTicker(t, "CAR"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((t) => t.id), ["1", "2"]);
});

test("ETF dividends without a ticker join TLT via CUSIP or fund name", () => {
  const tltBuy = trade({
    id: "tlt-buy",
    trade_date: "2026-03-18",
    side: "buy",
    symbol: "TLT",
    asset_type: "COLLECTIVE_INVESTMENT",
    description: "ISHARES 20+ YEAR TREASURY BOND ETF",
    cusip: "464287432",
    quantity: 100,
    net_amount: -8726,
    position_effect: "OPENING",
  });
  const nameAliases = aliasesForTicker("TLT", [tltBuy]);
  const cusipOnly = aliasesForTicker("TLT", [
    trade({
      id: "tlt-buy-bare",
      trade_date: "2026-03-18",
      side: "buy",
      symbol: "TLT",
      asset_type: "COLLECTIVE_INVESTMENT",
      description: null,
      cusip: "464287432",
    }),
  ]);

  const unnamed = {
    symbol: null,
    description: "ISHARES 20+ YEAR TREASURY BOND ETF",
    cusip: "464287432",
  };
  const unnamedNoCusip = {
    symbol: null as string | null,
    description: "ISHARES 20+ YEAR TREASURY BOND ETF",
    cusip: null as string | null,
  };
  assert.equal(distributionMatchesTicker(unnamed, "TLT", nameAliases), true);
  assert.equal(distributionMatchesTicker(unnamed, "TLT", cusipOnly), true);
  assert.equal(distributionMatchesTicker(unnamedNoCusip, "TLT", nameAliases), true);
  assert.equal(
    distributionMatchesTicker(unnamed, "CARD", aliasesForTicker("CARD", [tltBuy])),
    false,
  );
  assert.equal(
    distributionMatchesTicker(
      { symbol: null, description: "SPDR S&P 500", cusip: "78462F103" },
      "TLT",
      nameAliases,
    ),
    false,
  );
});

test("openMarkForTicker joins TLT via symbol or CUSIP and splits option MTM", () => {
  const tltBuy = trade({
    id: "tlt-buy",
    trade_date: "2026-03-18",
    side: "buy",
    symbol: "TLT",
    asset_type: "COLLECTIVE_INVESTMENT",
    description: "ISHARES 20+ YEAR TREASURY BOND ETF",
    cusip: "464287432",
  });
  const aliases = aliasesForTicker("TLT", [tltBuy]);
  const tlt = openMarkForTicker(
    [
      {
        id: "1",
        symbol: "TLT",
        underlying: null,
        description: "iShares 20+ Year Treasury Bond ETF",
        asset_type: "COLLECTIVE_INVESTMENT",
        quantity: 100,
        average_price: 87.26,
        market_value: 8900,
        day_pnl: null,
        open_pnl: 174,
        cusip: "464287432",
      },
    ],
    "TLT",
    aliases,
  );
  assert.equal(tlt.count, 1);
  assert.equal(tlt.equity_pnl, 174);
  assert.equal(tlt.option_pnl, 0);

  const unnamedFund = openMarkForTicker(
    [
      {
        id: "2",
        symbol: "ISHARES 20+ YEAR TREASURY BOND ETF",
        underlying: null,
        description: "ISHARES 20+ YEAR TREASURY BOND ETF",
        asset_type: "COLLECTIVE_INVESTMENT",
        quantity: 100,
        average_price: 87.26,
        market_value: 8900,
        day_pnl: null,
        open_pnl: null,
        cusip: "464287432",
      },
    ],
    "TLT",
    aliases,
  );
  assert.equal(unnamedFund.count, 1);
  assert.equal(unnamedFund.equity_pnl, 8900 - 87.26 * 100);

  const mixed = openMarkForTicker(
    [
      {
        id: "eq",
        symbol: "CAR",
        underlying: null,
        description: null,
        asset_type: "EQUITY",
        quantity: 10,
        average_price: 10,
        market_value: 120,
        day_pnl: null,
        open_pnl: 20,
        cusip: null,
      },
      {
        id: "opt",
        symbol: "CAR   260618P00390000",
        underlying: "CAR",
        description: null,
        asset_type: "OPTION",
        quantity: -1,
        average_price: 2.5,
        market_value: -200,
        day_pnl: null,
        open_pnl: 50,
        cusip: null,
      },
      {
        id: "other",
        symbol: "CARD",
        underlying: null,
        description: null,
        asset_type: "EQUITY",
        quantity: 1,
        average_price: 5,
        market_value: 6,
        day_pnl: null,
        open_pnl: 1,
        cusip: null,
      },
    ],
    "CAR",
    { cusips: new Set(), names: new Set() },
  );
  assert.equal(mixed.count, 2);
  assert.equal(mixed.equity_pnl, 20);
  assert.equal(mixed.option_pnl, 50);
});

