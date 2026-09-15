import { describe, expect, it } from "vitest";
import {
  asSettlementSnapshot,
  inferComboSettlement,
  isKalshiSettlementSource,
  kalshiResultYes,
  looksLikeSettlementPrint,
  settlementYes,
} from "./kalshi-settlement.js";

describe("settlementYes", () => {
  it("reads Kalshi result yes/no on a settled book", () => {
    expect(kalshiResultYes("yes")).toBe(1);
    expect(kalshiResultYes("NO")).toBe(0);
    expect(settlementYes({
      status: "settled",
      yes_last: 0.2,
      result: "yes",
    })).toBe(1);
  });

  it("accepts a 0/1 print tagged as settlement or settled status", () => {
    expect(looksLikeSettlementPrint(1, 1, 1)).toBe(true);
    expect(looksLikeSettlementPrint(0.18, 0.22, 0.20)).toBe(false);
    expect(settlementYes({
      status: "settled",
      yes_bid: 1,
      yes_ask: 1,
      yes_last: 1,
    })).toBe(1);
    expect(settlementYes({
      status: "active",
      source: "kalshi_settlement",
      yes_last: 0,
    })).toBe(0);
    expect(settlementYes({
      status: "active",
      yes_bid: 0.18,
      yes_ask: 0.22,
      yes_last: 0.20,
    })).toBeNull();
  });

  it("writes a tagged snapshot at close_time so quotes stay on candles", () => {
    const row = asSettlementSnapshot({
      status: "settled",
      yes_bid: 1,
      yes_ask: 1,
      yes_last: 1,
      no_bid: 0,
      no_ask: 0,
      source: "kalshi",
      fetched_at: "2026-09-15T12:00:00.000Z",
      close_time: "2026-09-15T03:12:00Z",
    });
    expect(row?.source).toBe("kalshi_settlement");
    expect(isKalshiSettlementSource(row?.source)).toBe(true);
    expect(row?.fetched_at).toBe("2026-09-15T03:12:00Z");
    expect(row?.yes_last).toBe(1);
  });

  it("infers a two-leg combo from selected-side hits", () => {
    expect(inferComboSettlement([
      { side: "yes", settlement: 1 },
      { side: "yes", settlement: 1 },
    ])).toBe(1);
    expect(inferComboSettlement([
      { side: "no", settlement: 0 },
      { side: "no", settlement: 0 },
    ])).toBe(1);
    expect(inferComboSettlement([
      { side: "yes", settlement: 1 },
      { side: "yes", settlement: 0 },
    ])).toBe(0);
    expect(inferComboSettlement([
      { side: "yes", settlement: 1 },
      { side: "no", settlement: null },
    ])).toBeNull();
  });
});
