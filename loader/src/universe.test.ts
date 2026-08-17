import { describe, expect, it } from "vitest";
import universe from "../symbols/universe.json";
import sp500 from "../symbols/sp500.json";
import etfs from "../symbols/etfs.json";

// Guards the loader's wiring to the merged universe: the jobs and the
// run-symbols enrichment read symbols/universe.json, which must be the union of
// the S&P 500 + a Nasdaq-100 delta + the curated ETF manifest, with a
// name/sector/source map for every symbol.
describe("symbols/universe.json (loader universe wiring)", () => {
  const symbols: string[] = universe.symbols;
  const cons = universe.constituents as Record<
    string,
    { name: string; sector: string; source: string }
  >;

  it("has a sorted, unique symbol list fully covered by the constituents map", () => {
    expect(symbols).toEqual([...symbols].sort());
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const s of symbols) {
      expect(cons[s]).toBeDefined();
      expect(cons[s].name).toBeTruthy();
      expect(cons[s].sector).toBeTruthy();
    }
  });

  it("is the union of the S&P 500, the ETF manifest, and a Nasdaq-100 delta", () => {
    const spx = new Set((sp500.symbols as string[]).map((s) => s.toUpperCase()));
    const etf = new Set((etfs.etfs as { symbol: string }[]).map((e) => e.symbol.toUpperCase()));
    const bySource: Record<string, number> = {};
    for (const s of symbols) bySource[cons[s].source] = (bySource[cons[s].source] ?? 0) + 1;

    expect(bySource["sp500"]).toBe(spx.size);
    expect(bySource["etf"]).toBe(etf.size);
    // Nasdaq-100 delta = exactly the symbols that are in neither S&P 500 nor ETFs.
    const delta = symbols.filter((s) => !spx.has(s) && !etf.has(s));
    expect(bySource["nasdaq100"]).toBe(delta.length);
    expect(symbols.length).toBe(spx.size + etf.size + delta.length);
    for (const d of delta) expect(cons[d].source).toBe("nasdaq100");
  });

  it("covers major indexes and ETFs beyond the S&P 500 (representative members)", () => {
    // Nasdaq-100 members not in the S&P 500 (verified 2026-08-09).
    for (const s of ["ASML", "ARM", "MSTR", "SHOP", "MELI", "RKLB", "ALNY", "NBIS"]) {
      expect(symbols).toContain(s);
      expect(cons[s].source).toBe("nasdaq100");
    }
    // Major ETFs + VIX ETP sleeve.
    for (const s of ["SPY", "QQQ", "IWM", "TLT", "GLD", "XLE", "EEM", "TQQQ", "VXX", "UVXY", "SVXY"]) {
      expect(symbols).toContain(s);
      expect(cons[s].source).toBe("etf");
    }
  });
});
