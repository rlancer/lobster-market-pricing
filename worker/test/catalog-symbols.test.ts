import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogLookup,
  catalogSymbols,
  mergeSymbolUniverse,
  rankSymbolSuggestions,
} from "../src/catalog-symbols";

describe("catalog-symbols", () => {
  it("loads VIX indexes and CME continuous futures from loader manifests", () => {
    const all = catalogSymbols();
    assert.ok(all.some((s) => s.symbol === "^VIX" && s.kind === "index"));
    assert.ok(all.some((s) => s.symbol === "ES=F" && s.kind === "future"));
    assert.equal(catalogLookup("^vix")?.name, "CBOE Volatility Index");
    assert.equal(catalogLookup("es=f")?.sector, "Equity Index");
  });

  it("merges catalog extras under lake underlyings", () => {
    const merged = mergeSymbolUniverse([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
      { symbol: "VXX", name: "iPath VXX", sector: "Volatility" },
    ]);
    assert.ok(merged.some((s) => s.symbol === "AAPL"));
    assert.ok(merged.some((s) => s.symbol === "^VIX"));
    assert.ok(merged.some((s) => s.symbol === "ES=F"));
    assert.ok(merged.some((s) => s.symbol === "VXX" && s.name === "iPath VXX"));
  });

  it("ranks ^VIX ahead of VIXY when querying VIX", () => {
    const ranked = rankSymbolSuggestions(
      mergeSymbolUniverse([{ symbol: "VIXY", name: "ProShares VIX Short-Term", sector: "Volatility" }]),
      "VIX",
      10,
    );
    assert.equal(ranked[0]?.symbol, "^VIX");
  });

  it("finds continuous futures by prefix", () => {
    const ranked = rankSymbolSuggestions(mergeSymbolUniverse([]), "ES", 10);
    assert.ok(ranked.some((s) => s.symbol === "ES=F"));
  });
});
