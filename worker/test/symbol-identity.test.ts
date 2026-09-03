import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLookupIdentity,
  formatHoldingWeight,
  formatSymbolIdentities,
  isDiversifiedVehicle,
  kindFromSchwabAssetType,
  kindFromYahooQuoteType,
  lookupSymbolIdentities,
  parseYahooEtfComposition,
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

test("parseYahooEtfComposition maps top holdings and fund stats", () => {
  const composition = parseYahooEtfComposition({
    quoteSummary: {
      result: [{
        fundProfile: {
          family: "Invesco",
          categoryName: "Large Blend",
          feesExpensesInvestment: { annualReportExpenseRatio: { raw: 0.002 } },
        },
        defaultKeyStatistics: { totalAssets: { raw: 7.2e10 } },
        topHoldings: {
          holdings: [
            { symbol: "NVDA", holdingName: "NVIDIA Corp", holdingPercent: { raw: 0.0022 } },
            { symbol: "AAPL", holdingName: "Apple Inc", holdingPercent: { raw: 0.0021 } },
          ],
        },
      }],
    },
  });
  assert.ok(composition);
  assert.equal(composition.family, "Invesco");
  assert.equal(composition.category, "Large Blend");
  assert.equal(composition.net_assets, 7.2e10);
  assert.equal(composition.holdings.length, 2);
  assert.equal(composition.holdings[0]!.holding_symbol, "NVDA");
  assert.equal(composition.holdings[0]!.weight, 0.0022);
  assert.equal(formatHoldingWeight(0.0022), "0.22%");
  assert.equal(formatHoldingWeight(0.075), "7.50%");
});

function yahooLookupFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("fc.yahoo.com")) {
      return new Response("", {
        status: 302,
        headers: { "set-cookie": "A=1; Path=/" },
      });
    }
    if (url.includes("getcrumb")) {
      return new Response("crumb1", { status: 200 });
    }
    if (url.includes("quoteSummary")) {
      return new Response(JSON.stringify({
        quoteSummary: {
          result: [{
            fundProfile: {
              family: "Invesco",
              categoryName: "Large Blend",
              feesExpensesInvestment: { annualReportExpenseRatio: { raw: 0.002 } },
            },
            defaultKeyStatistics: { totalAssets: { raw: 7.2e10 } },
            topHoldings: {
              holdings: [
                { symbol: "NVDA", holdingName: "NVIDIA", holdingPercent: { raw: 0.0022 } },
                { symbol: "MSFT", holdingName: "Microsoft", holdingPercent: { raw: 0.0021 } },
              ],
            },
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q") ?? "";
    return new Response(JSON.stringify({
      quotes: [{
        symbol: q.toUpperCase(),
        quoteType: "ETF",
        longname: "Invesco S&P 500 Equal Weight ETF",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("lookupSymbolIdentities uses catalog for indexes and Yahoo holdings for funds", async () => {
  const { fetchImpl, calls } = yahooLookupFetch();
  const rows = await lookupSymbolIdentities(["^VIX", "RSP"], { fetchImpl });
  assert.equal(rows[0]!.symbol, "^VIX");
  assert.equal(rows[0]!.kind, "index");
  assert.equal(rows[0]!.source, "catalog");
  assert.equal(rows[1]!.symbol, "RSP");
  assert.equal(rows[1]!.kind, "etf");
  assert.equal(rows[1]!.name, "Invesco S&P 500 Equal Weight ETF");
  assert.equal(rows[1]!.source, "yahoo");
  assert.equal(rows[1]!.family, "Invesco");
  assert.equal(rows[1]!.holdings?.length, 2);
  assert.equal(rows[1]!.holdings?.[0]!.holding_symbol, "NVDA");
  assert.ok(calls.some((u) => u.includes("q=RSP")));
  assert.ok(calls.some((u) => u.includes("quoteSummary/RSP")));
  assert.ok(!calls.some((u) => u.includes("quoteSummary/%5EVIX") || u.includes("quoteSummary/^VIX")));
});

test("applyLookupIdentity fills a nameless ETF brief including holdings", () => {
  const research = {
    identity: { name: null as string | null, ticker: "RSP" },
    etf: null as null,
  };
  const out = applyLookupIdentity(research, {
    symbol: "RSP",
    name: "Invesco S&P 500 Equal Weight ETF",
    kind: "etf",
    source: "yahoo",
    family: "Invesco",
    category: "Large Blend",
    holdings: [{ rank: 1, holding_symbol: "NVDA", holding_name: "NVIDIA", weight: 0.0022 }],
  });
  assert.equal(out.identity.name, "Invesco S&P 500 Equal Weight ETF");
  assert.equal(out.etf?.family, "Invesco");
  assert.equal(out.etf?.holdings?.[0]!.holding_symbol, "NVDA");
});

test("formatSymbolIdentities includes top holdings for funds", () => {
  const text = formatSymbolIdentities([
    {
      symbol: "RSP",
      name: "Invesco S&P 500 Equal Weight ETF",
      kind: "etf",
      source: "yahoo",
      family: "Invesco",
      category: "Large Blend",
      net_assets: 7.2e10,
      expense_ratio: 0.002,
      holdings: [
        { rank: 1, holding_symbol: "NVDA", holding_name: "NVIDIA", weight: 0.0022 },
        { rank: 2, holding_symbol: "AAPL", holding_name: "Apple", weight: 0.0021 },
      ],
    },
    { symbol: "ZZZ", name: null, kind: "unknown", source: "none" },
  ]);
  assert.match(text, /RSP · etf · Invesco S&P 500 Equal Weight ETF \(yahoo\)/);
  assert.match(text, /Invesco · Large Blend · AUM \$72\.0B · 0\.20% ER/);
  assert.match(text, /top holdings \(Yahoo top-10, not the full book\): NVDA 0\.22%, AAPL 0\.21%/);
  assert.match(text, /ZZZ · unknown · name unknown \(no lookup hit\)/);
});
