import { describe, expect, it } from "vitest";
import {
  bundledUniverse,
  enrollSymbol,
  effectiveUniverse,
  expectedUniverseSize,
  isBundledSymbol,
  isEnrollableTicker,
  listEnrolledSymbols,
  normalizeEnrollTicker,
} from "./enrolled-universe.js";
import type { D1Database, D1PreparedStatement } from "./scheduler.js";

type Row = Record<string, unknown>;

/** Minimal in-memory D1 for enrollment tests. */
class MemoryDb implements D1Database {
  enrolled = new Map<string, Row>();
  symbolState = new Map<string, Row>();
  ohlcBackfill = new Map<string, Row>();
  researchBrief = new Map<string, Row>();

  prepare(query: string): D1PreparedStatement {
    const self = this;
    let binds: unknown[] = [];
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]) {
        binds = values;
        return stmt;
      },
      async first() {
        if (query.includes("COUNT(*)") && query.includes("enrolled_symbols")) {
          let c = 0;
          for (const r of self.enrolled.values()) if (Number(r.enabled) === 1) c += 1;
          return { c };
        }
        if (query.includes("FROM enrolled_symbols WHERE symbol")) {
          const sym = String(binds[0] || "").toUpperCase();
          return self.enrolled.get(sym) || null;
        }
        return null;
      },
      async all<T extends Record<string, unknown> = Record<string, unknown>>() {
        if (query.includes("FROM enrolled_symbols") && query.includes("enabled = 1")) {
          return {
            success: true,
            results: Array.from(self.enrolled.values())
              .filter((r) => Number(r.enabled) === 1)
              .map((r) => ({ symbol: String(r.symbol) }) as unknown as T)
              .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))),
          };
        }
        if (query.includes("FROM enrolled_symbols") && query.includes("ORDER BY requested_at")) {
          return {
            success: true,
            results: Array.from(self.enrolled.values()) as T[],
          };
        }
        return { success: true, results: [] as T[] };
      },
      async run() {
        if (query.startsWith("INSERT INTO enrolled_symbols")) {
          const [symbol, source, requested_by, requested_at, notes] = binds;
          const sym = String(symbol).toUpperCase();
          self.enrolled.set(sym, {
            symbol: sym,
            source,
            requested_by,
            requested_at,
            enabled: 1,
            last_error: null,
            notes,
          });
        } else if (query.startsWith("UPDATE enrolled_symbols")) {
          const symbol = String(binds[binds.length - 1]).toUpperCase();
          const row = self.enrolled.get(symbol);
          if (row) {
            row.enabled = 1;
            row.source = binds[0];
            if (binds[1] != null) row.requested_by = binds[1];
            if (binds[2] != null) row.notes = binds[2];
            row.last_error = null;
          }
        } else if (query.includes("INSERT OR IGNORE INTO symbol_state")) {
          const sym = String(binds[0]).toUpperCase();
          if (!self.symbolState.has(sym)) {
            self.symbolState.set(sym, { symbol: sym, enabled: 1, next_attempt_after: 0 });
          }
        } else if (query.includes("UPDATE symbol_state")) {
          const sym = String(binds[0]).toUpperCase();
          const row = self.symbolState.get(sym);
          if (row) {
            row.enabled = 1;
            row.next_attempt_after = 0;
          }
        } else if (query.includes("INSERT OR IGNORE INTO ohlc_backfill_state")) {
          const sym = String(binds[0]).toUpperCase();
          if (!self.ohlcBackfill.has(sym)) {
            self.ohlcBackfill.set(sym, { symbol: sym, enabled: 1 });
          }
        } else if (query.includes("UPDATE ohlc_backfill_state")) {
          const sym = String(binds[0]).toUpperCase();
          const row = self.ohlcBackfill.get(sym);
          if (row) row.enabled = 1;
        } else if (query.includes("INSERT OR IGNORE INTO research_brief_state")) {
          const sym = String(binds[0]).toUpperCase();
          if (!self.researchBrief.has(sym)) {
            self.researchBrief.set(sym, { symbol: sym, enabled: 1 });
          }
        } else if (query.includes("UPDATE research_brief_state")) {
          const sym = String(binds[0]).toUpperCase();
          const row = self.researchBrief.get(sym);
          if (row) row.enabled = 1;
        }
        return { success: true };
      },
    };
    return stmt;
  }
}

describe("enrolled-universe helpers", () => {
  it("accepts equity tickers and rejects indexes/futures", () => {
    expect(isEnrollableTicker("sofi")).toBe(true);
    expect(normalizeEnrollTicker("sofi")).toBe("SOFI");
    expect(isEnrollableTicker("^VIX")).toBe(false);
    expect(isEnrollableTicker("ES=F")).toBe(false);
    expect(isEnrollableTicker("BTC-USD")).toBe(false);
    expect(normalizeEnrollTicker("^VIX")).toBeNull();
    expect(normalizeEnrollTicker("BTC-USD")).toBeNull();
  });

  it("knows bundled universe membership", () => {
    expect(isBundledSymbol("AAPL")).toBe(true);
    expect(bundledUniverse().length).toBeGreaterThan(500);
    expect(isBundledSymbol("ZZZZNOTREAL")).toBe(false);
  });

  it("enrolls a ticker into D1 and every equity item store", async () => {
    const db = new MemoryDb();
    const result = await enrollSymbol(db, "sofi", {
      source: "test",
      requestedBy: "chat-1",
      now: 1_700_000_000_000,
    });
    expect(result).toEqual({
      symbol: "SOFI",
      enrolled: true,
      already: false,
      bundled: false,
      enabled: true,
    });
    expect(await listEnrolledSymbols(db)).toEqual(["SOFI"]);
    expect(db.symbolState.has("SOFI")).toBe(true);
    expect(db.ohlcBackfill.has("SOFI")).toBe(true);
    expect(db.researchBrief.has("SOFI")).toBe(true);

    const again = await enrollSymbol(db, "SOFI", { source: "test" });
    expect(again.already).toBe(true);
    expect(await expectedUniverseSize(db)).toBe(bundledUniverse().length + 1);

    const uni = await effectiveUniverse(db);
    expect(uni).toContain("SOFI");
    expect(uni).toContain("AAPL");
  });

  it("does not double-count enrolled tickers that are already bundled", async () => {
    const db = new MemoryDb();
    await enrollSymbol(db, "AAPL", { source: "test" });
    expect(await expectedUniverseSize(db)).toBe(bundledUniverse().length);
  });
});
