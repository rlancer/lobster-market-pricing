// Live probe for futures paths on this branch.
//   node --experimental-strip-types tools/futures_probe.ts
// Dry-run: fetches + normalizes only (no PIPELINE_*_URL).
import futures from "../symbols/futures.json" with { type: "json" };
import { publishOhlc } from "../src/ohlc.ts";
import {
  fetchQuoteRows,
  fetchSettlementRows,
  settlementToQuoteSymbol,
} from "../src/futures.ts";

const mode = process.argv[2] || "all"; // all | ohlc | cfe
const FUTURES = Array.isArray(futures.futures) ? futures.futures : [];

async function probeOhlc() {
  const symbols = FUTURES.map((f: { symbol: string }) => f.symbol);
  console.log(`\n=== futures-ohlc-daily universe (${symbols.length}) ===`);
  const env = { OHLC_SOURCE: "yahoo", HTTP_RETRIES: 2 };
  let ok = 0;
  const failures: Array<{ symbol: string; error: string }> = [];
  // Modest concurrency so Yahoo doesn't 429 the probe.
  const concurrency = 4;
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= symbols.length) return;
      const symbol = symbols[i];
      try {
        const result = await publishOhlc(symbol, env);
        console.log(
          `OK ${symbol} bars=${result.bar_count} rv30=${result.realized_vol_30d?.toFixed(4) ?? "null"} rv90=${result.realized_vol_90d?.toFixed(4) ?? "null"}`,
        );
        ok += 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`FAIL ${symbol}: ${msg}`);
        failures.push({ symbol, error: msg });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log(`ohlc summary: ok=${ok} fail=${failures.length}`);
  return failures;
}

async function probeCfe() {
  console.log("\n=== cfe-futures-daily (settlements + quotes) ===");
  const env = {
    HTTP_RETRIES: 2,
    runId: () => "probe-cfe",
    now: () => new Date(),
  };
  const settlements = await fetchSettlementRows(env);
  const byProduct = new Map<string, number>();
  for (const row of settlements) {
    byProduct.set(row.product, (byProduct.get(row.product) || 0) + 1);
  }
  console.log(
    `settlements rows=${settlements.length} products=${[...byProduct.entries()].map(([k, v]) => `${k}:${v}`).join(" ")}`,
  );

  const monthals = settlements
    .map((r) => ({
      settle: r.contract_symbol,
      quote: settlementToQuoteSymbol(r.product, r.contract_symbol),
      product: r.product,
      expiration: r.expiration_date,
      settle_price: r.settle_price,
    }))
    .filter((r) => r.quote);
  console.log(`monthals mappable to quotes: ${monthals.length}`);
  for (const row of monthals.slice(0, 12)) {
    console.log(
      `  ${row.product} ${row.settle} → ${row.quote} exp=${row.expiration} settle=${row.settle_price}`,
    );
  }

  const quotes = await fetchQuoteRows(settlements, env);
  console.log(`quotes fetched=${quotes.length}`);
  for (const q of quotes.slice(0, 15)) {
    console.log(
      `  ${q.contract_symbol} root=${q.root} last=${q.last} oi=${q.open_interest} vol=${q.volume} exp=${q.expiration_date}`,
    );
  }
  if (quotes.length === 0) {
    throw new Error("expected at least one CFE delayed quote");
  }
}

const failures: Array<{ symbol: string; error: string }> = [];
if (mode === "all" || mode === "ohlc") failures.push(...(await probeOhlc()));
if (mode === "all" || mode === "cfe") {
  try {
    await probeCfe();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`FAIL cfe: ${msg}`);
    failures.push({ symbol: "cfe", error: msg });
  }
}

if (failures.length) {
  console.error("\nPROBE FAILURES:", failures);
  process.exit(1);
}
console.log("\nPROBE OK");
