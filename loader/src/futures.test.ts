import { describe, expect, it } from "vitest";
import {
  normalizeQuotePayload,
  parseSettlementCsv,
  settlementToQuoteSymbol,
} from "./futures.js";

describe("settlementToQuoteSymbol", () => {
  const now = new Date("2026-08-17T12:00:00Z");

  it("maps monthly settle symbols to ROOT+M+YY quote codes", () => {
    expect(settlementToQuoteSymbol("VX", "VX/U6", now)).toBe("VXU26");
    expect(settlementToQuoteSymbol("VX", "VX/F7", now)).toBe("VXF27");
    expect(settlementToQuoteSymbol("IBHY", "IBHY/Z6", now)).toBe("IBHYZ26");
  });

  it("skips weeklies (product root mismatch on the left of /)", () => {
    expect(settlementToQuoteSymbol("VX", "VX34/Q6", now)).toBeNull();
    expect(settlementToQuoteSymbol("VX", "VX35/U6", now)).toBeNull();
  });
});

describe("parseSettlementCsv", () => {
  it("parses the CBOE settlement CSV shape", () => {
    const csv = [
      "Product,Symbol,Expiration Date,Price",
      "VX,VX/Q6,2026-08-19,15.5594",
      "VX,VX34/Q6,2026-08-26,15.5594",
      "IBHY,IBHY/U6,2026-09-01,183.975",
    ].join("\n");
    const rows = parseSettlementCsv(csv, "run-1", "2026-08-17", "2026-08-17T12:00:00.000Z");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      product: "VX",
      contract_symbol: "VX/Q6",
      expiration_date: "2026-08-19",
      settle_price: 15.5594,
      source: "cboe",
      run_id: "run-1",
    });
    expect(rows[1].contract_symbol).toBe("VX34/Q6");
    expect(rows[2].product).toBe("IBHY");
  });

  it("rejects a CSV missing required columns", () => {
    expect(() => parseSettlementCsv("A,B\n1,2", "r", "2026-08-17", "t")).toThrow(/missing required columns/);
  });
});

describe("normalizeQuotePayload", () => {
  it("maps CBOE delayed futures quote JSON", () => {
    const row = normalizeQuotePayload(
      {
        timestamp: "2026-08-17 12:00:00",
        data: {
          symbol: "VXU26",
          security_type: "future",
          current_price: 18.0,
          bid: 17.95,
          ask: 18.05,
          open: 18.1,
          high: 18.5,
          low: 17.8,
          close: 18.0,
          prev_day_close: 18.2,
          volume: 1000,
          open_interest: 50000,
          settlement_price: 18.11,
          settlement_date: "2026-09-16T00:00:00",
        },
      },
      "VX",
      "run-q",
      "2026-08-17",
      "2026-08-17T12:00:00.000Z",
    );
    expect(row).toMatchObject({
      root: "VX",
      contract_symbol: "VXU26",
      security_type: "future",
      expiration_date: "2026-09-16",
      last: 18.0,
      bid: 17.95,
      ask: 18.05,
      volume: 1000,
      open_interest: 50000,
      settlement_price: 18.11,
      source: "cboe",
      run_id: "run-q",
    });
  });
});
