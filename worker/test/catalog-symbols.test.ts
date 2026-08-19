import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogLookup,
  catalogSymbols,
  continuousFuturesRoot,
  mergeSymbolUniverse,
  rankSymbolSuggestions,
  resolveSlashRoot,
} from "../src/catalog-symbols";

describe("catalog-symbols", () => {
  it("loads VIX indexes, CME continuous futures, and spot crypto from loader manifests", () => {
    const all = catalogSymbols();
    assert.ok(all.some((s) => s.symbol === "^VIX" && s.kind === "index"));
    assert.ok(all.some((s) => s.symbol === "ES=F" && s.kind === "future"));
    assert.ok(all.some((s) => s.symbol === "BTC-USD" && s.kind === "crypto"));
    assert.ok(all.some((s) => s.symbol === "MBT=F" && s.kind === "future"));
    assert.equal(catalogLookup("^vix")?.name?.includes("CBOE Volatility Index"), true);
    assert.equal(catalogLookup("es=f")?.sector, "Equity Index");
    assert.equal(catalogLookup("btc-usd")?.name, "Bitcoin");
    assert.equal(continuousFuturesRoot("ES=F"), "ES");
  });

  it("merges catalog extras under lake underlyings", () => {
    const merged = mergeSymbolUniverse([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
      { symbol: "VXX", name: "iPath VXX", sector: "Volatility" },
    ]);
    assert.ok(merged.some((s) => s.symbol === "AAPL"));
    assert.ok(merged.some((s) => s.symbol === "^VIX"));
    assert.ok(merged.some((s) => s.symbol === "ES=F"));
    assert.ok(merged.some((s) => s.symbol === "BTC-USD"));
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

  it("ranks BTC-USD ahead of BTC=F when querying BTC", () => {
    const ranked = rankSymbolSuggestions(mergeSymbolUniverse([]), "BTC", 10);
    assert.equal(ranked[0]?.symbol, "BTC-USD");
    assert.ok(ranked.some((s) => s.symbol === "BTC=F"));
  });

  it("finds continuous futures by prefix", () => {
    const ranked = rankSymbolSuggestions(mergeSymbolUniverse([]), "ES", 10);
    assert.ok(ranked.some((s) => s.symbol === "ES=F"));
  });

  it("resolves Thinkorswim-style slash roots", () => {
    assert.equal(resolveSlashRoot("/ES"), "ES=F");
    assert.equal(resolveSlashRoot("/es"), "ES=F");
    assert.equal(resolveSlashRoot("/VX"), "^VIX");
    assert.equal(resolveSlashRoot("/vx"), "^VIX");
    assert.equal(resolveSlashRoot("/NQ"), "NQ=F");
    assert.equal(resolveSlashRoot("/nope"), null);
  });

  it("ranks /vx to ^VIX without equity noise like CVX", () => {
    const ranked = rankSymbolSuggestions(
      mergeSymbolUniverse([
        { symbol: "CVX", name: "Chevron", sector: "Energy" },
        { symbol: "VXX", name: "iPath VXX", sector: "Volatility" },
      ]),
      "/vx",
      10,
    );
    assert.equal(ranked[0]?.symbol, "^VIX");
    assert.ok(!ranked.some((s) => s.symbol === "CVX"));
    assert.ok(!ranked.some((s) => s.symbol === "VXX"));
  });

  it("lists futures for a bare slash", () => {
    const ranked = rankSymbolSuggestions(mergeSymbolUniverse([]), "/", 50);
    assert.ok(ranked.some((s) => s.symbol === "ES=F"));
    assert.ok(ranked.some((s) => s.symbol === "^VIX"));
    assert.ok(!ranked.some((s) => s.symbol === "AAPL"));
  });
});
