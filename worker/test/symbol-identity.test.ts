import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLookupIdentity,
  formatSymbolIdentities,
  isDiversifiedVehicle,
  kindFromSchwabAssetType,
  kindFromYahooQuoteType,
  lookupSymbolIdentities,
  parseYahooSearchIdentity,
  sanitizeLookupSymbols,
} from "../src/symbol-identity.ts";

test("kindFromSchwabAssetType maps broker types, including ETF wrappers", () => {
  assert.equal(kindFromSchwabAssetType("EQUITY"), "equity");
  assert.equal(kindFromSchwabAssetType("COLLECTIVE_INVESTMENT"), "etf");
  assert.equal(kindFromSchwabAssetType("MUTUAL_FUND"), "fund");
  assert.equal(kindFromSchwabAssetType("OPTION"), "option");
  assert.equal(kindFromSchwabAssetType(null), "unknown");
});

test("kindFromYahooQuoteType maps search quoteType", () => {
  assert.equal(kindFromYahooQuoteType("ETF"), "etf");
  assert.equal(kindFromYahooQuoteType("EQUITY"), "equity");
  assert.equal(kindFromYahooQuoteType("INDEX"), "index");
  assert.equal(kindFromYahooQuoteType("MUTUALFUND"), "fund");
});

test("isDiversifiedVehicle treats ETFs and funds as baskets, not single names", () => {
  assert.equal(isDiversifiedVehicle("etf"), true);
  assert.equal(isDiversifiedVehicle("fund"), true);
  assert.equal(isDiversifiedVehicle("index"), true);
  assert.equal(isDiversifiedVehicle("equity"), false);
  assert.equal(isDiversifiedVehicle("option"), false);
});

test("sanitizeLookupSymbols uppercases, uniques, and caps the batch", () => {
  assert.deepEqual(sanitizeLookupSymbols(["rsp", "RSP", " igv "]), ["RSP", "IGV"]);
  assert.equal(sanitizeLookupSymbols(Array.from({ length: 30 }, (_, i) => `T${i}`)).length, 20);
  assert.deepEqual(sanitizeLookupSymbols(["$$", ""]), []);
});

test("parseYahooSearchIdentity picks the exact symbol and ETF kind", () => {
  const id = parseYahooSearchIdentity({
    quotes: [
      { symbol: "RSPN", quoteType: "ETF", shortname: "wrong" },
      {
        symbol: "RSP",
        quoteType: "ETF",
        shortname: "Invesco S&P 500 Equal Weight ETF",
        longname: "Invesco S&P 500 Equal Weight ETF",
      },
    ],
  }, "rsp");
  assert.ok(id);
  assert.equal(id.symbol, "RSP");
  assert.equal(id.kind, "etf");
  assert.equal(id.name, "Invesco S&P 500 Equal Weight ETF");
  assert.equal(id.source, "yahoo");
});

test("lookupSymbolIdentities uses catalog for indexes and Yahoo for unknown funds", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    const url = new URL(String(input));
    const q = url.searchParams.get("q") ?? "";
    return new Response(JSON.stringify({
      quotes: [{
        symbol: q.toUpperCase(),
        quoteType: "ETF",
        longname: "Invesco S&P 500 Equal Weight ETF",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const rows = await lookupSymbolIdentities(["^VIX", "RSP"], { fetchImpl });
  assert.equal(rows[0]!.symbol, "^VIX");
  assert.equal(rows[0]!.kind, "index");
  assert.equal(rows[0]!.source, "catalog");
  assert.equal(rows[1]!.symbol, "RSP");
  assert.equal(rows[1]!.kind, "etf");
  assert.equal(rows[1]!.name, "Invesco S&P 500 Equal Weight ETF");
  assert.equal(rows[1]!.source, "yahoo");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /q=RSP/);
});

test("applyLookupIdentity fills a nameless ETF brief", () => {
  const research = {
    identity: { name: null as string | null, ticker: "RSP" },
    etf: null as null,
  };
  const out = applyLookupIdentity(research, {
    symbol: "RSP",
    name: "Invesco S&P 500 Equal Weight ETF",
    kind: "etf",
    source: "yahoo",
  });
  assert.equal(out.identity.name, "Invesco S&P 500 Equal Weight ETF");
  assert.equal(out.etf?.category, "etf");
  assert.equal(out.etf?.name, "Invesco S&P 500 Equal Weight ETF");
});

test("formatSymbolIdentities is model-readable", () => {
  const text = formatSymbolIdentities([
    { symbol: "RSP", name: "Invesco S&P 500 Equal Weight ETF", kind: "etf", source: "yahoo" },
    { symbol: "ZZZ", name: null, kind: "unknown", source: "none" },
  ]);
  assert.match(text, /RSP · etf · Invesco S&P 500 Equal Weight ETF \(yahoo\)/);
  assert.match(text, /ZZZ · unknown · name unknown \(no lookup hit\)/);
});
