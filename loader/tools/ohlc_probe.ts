// Live probe for the OHLC + realized-vol prototype.
// Run from loader/:  node tools/ohlc_probe.ts AAPL MSFT
import { publishOhlc, realizedVols, parseYahooChart } from "../src/ohlc.ts";

const symbols = process.argv.slice(2);
if (symbols.length === 0) {
  console.error("usage: node tools/ohlc_probe.ts <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const env = {
  // dry-run: no PIPELINE_*_URL set, so publishOhlc fetches + normalizes only.
  OHLC_SOURCE: "yahoo",
};

for (const symbol of symbols) {
  try {
    const result = await publishOhlc(symbol, env);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`FAIL ${symbol}:`, error instanceof Error ? error.message : error);
  }
}
