import { describe, expect, it } from "vitest";
import {
  canAffordParlay,
  fillCashDebit,
  kalshiTakerFee,
  loadParlaySpendBudget,
  parlayMaxSpend,
  parlaySpendRunId,
  quoteYesDebit,
  resolveParlaySpendSince,
  sumFillSpendSince,
} from "./kalshi-parlay-spend.js";
import type { ParlayPortfolioFill } from "./kalshi-parlay-fills.js";

function fill(overrides: Partial<ParlayPortfolioFill> = {}): ParlayPortfolioFill {
  return {
    market_ticker: "KXMVECROSSCATEGORY-SHARD1-ABC",
    side: "no",
    contracts: 10,
    yes_price: 0.25,
    no_price: 0.75,
    fee: 0.1313,
    created_time: "2026-09-15T00:52:39.777Z",
    ...overrides,
  };
}

function memoryMetaDb(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    prepare(query: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async first() {
          if (query.includes("SELECT value FROM loader_meta")) {
            const value = store.get(String(binds[0]));
            return value != null ? { value } : null;
          }
          return null;
        },
        async all() {
          return { success: true, results: [] };
        },
        async run() {
          if (query.includes("INSERT INTO loader_meta")) {
            store.set(String(binds[0]), String(binds[1]));
          }
          return { success: true };
        },
      };
      return stmt;
    },
    store,
  };
}

describe("parlay spend cap", () => {
  it("defaults to a $100 run cap and underdog-5x100 run id", () => {
    expect(parlayMaxSpend({})).toBe(100);
    expect(parlayMaxSpend({ KALSHI_PARLAY_MAX_SPEND: 0 })).toBe(100);
    expect(parlayMaxSpend({ KALSHI_PARLAY_MAX_SPEND: "250" })).toBe(250);
    expect(parlaySpendRunId({})).toBe("underdog-5x100");
  });

  it("debits BUY NO at no_price and BUY YES at yes_price plus fee", () => {
    expect(fillCashDebit(fill())).toBeCloseTo(7.6313);
    expect(fillCashDebit(fill({ side: "yes", yes_price: 0.21, no_price: 0.79, contracts: 5, fee: 0.08 }))).toBeCloseTo(1.13);
  });

  it("estimates the next YES ticket as contracts × (ask + taker fee)", () => {
    const debit = quoteYesDebit(0.21, 5);
    expect(debit).toBeCloseTo(5 * (0.21 + kalshiTakerFee(0.21)));
    expect(canAffordParlay(98.5, debit, 100)).toBe(true);
    expect(canAffordParlay(99.5, debit, 100)).toBe(false);
  });

  it("ignores fills before the run watermark so last night does not eat the cap", () => {
    const spent = sumFillSpendSince(
      [
        fill({ created_time: "2026-09-15T00:52:39.777Z" }),
        fill({
          side: "yes",
          contracts: 5,
          yes_price: 0.20,
          no_price: 0.80,
          fee: 0.05,
          created_time: "2026-09-15T18:00:00.000Z",
        }),
      ],
      "2026-09-15T12:00:00.000Z",
    );
    expect(spent).toBeCloseTo(1.05);
  });

  it("stamps started_at in D1 on first pass for a run id", async () => {
    const db = memoryMetaDb();
    const first = await resolveParlaySpendSince({
      LOADER_DB: db,
      KALSHI_PARLAY_SPEND_RUN_ID: "underdog-5x100",
    }, Date.parse("2026-09-15T20:30:00.000Z"));
    expect(first.source).toBe("new");
    expect(first.since).toBe("2026-09-15T20:30:00.000Z");
    const second = await resolveParlaySpendSince({
      LOADER_DB: db,
      KALSHI_PARLAY_SPEND_RUN_ID: "underdog-5x100",
    }, Date.parse("2026-09-16T00:00:00.000Z"));
    expect(second.source).toBe("d1");
    expect(second.since).toBe("2026-09-15T20:30:00.000Z");
  });

  it("refuses live accepts when there is no watermark", async () => {
    const budget = await loadParlaySpendBudget({}, { live: true, fills: [] });
    expect(budget.since).toBeNull();
    expect(budget.can_accept).toBe(false);
    expect(budget.error).toMatch(/watermark/);
  });

  it("treats a filled cap as not affordable", async () => {
    const budget = await loadParlaySpendBudget(
      { KALSHI_PARLAY_SPEND_SINCE: "2026-09-15T12:00:00.000Z" },
      {
        live: true,
        fills: [fill({
          side: "yes",
          contracts: 200,
          yes_price: 0.50,
          no_price: 0.50,
          fee: 0,
          created_time: "2026-09-15T18:00:00.000Z",
        })],
      },
    );
    expect(budget.spent).toBe(100);
    expect(budget.can_accept).toBe(false);
    expect(budget.remaining).toBe(0);
  });
});
