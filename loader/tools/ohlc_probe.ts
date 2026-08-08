// Live probe for the OHLC + realized-vol + corporate-actions path.
// Run from loader/:
//   node tools/ohlc_probe.ts AAPL MSFT          (daily range=1y)
//   node tools/ohlc_probe.ts --range 730 AAPL   (2y backfill window)
import { publishOhlc, publishOhlcRange } from "../src/ohlc.ts";
import { securityIdForTicker } from "../src/symbology.ts";

const args = process.argv.slice(2);
const rangeIdx = args.indexOf("--range");
const rangeDays = rangeIdx >= 0 ? Number(args[rangeIdx + 1]) : 0;
let symbols = rangeIdx >= 0 ? args.slice(0, rangeIdx).concat(args.slice(rangeIdx + 2)) : args;
symbols = symbols.filter(Boolean);

if (symbols.length === 0) {
  console.error("usage: node tools/ohlc_probe.ts [--range DAYS] <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const env = {
  // dry-run: no PIPELINE_*_URL set, so publish fetches + normalizes only.
  OHLC_SOURCE: "yahoo",
};

for (const symbol of symbols) {
  try {
    const result = rangeDays > 0
      ? await publishOhlcRange(
          symbol,
          Math.floor(Date.now() / 1000) - rangeDays * 86400,
          Math.floor(Date.now() / 1000),
          env,
          securityIdForTicker(symbol),
        )
      : await publishOhlc(symbol, env);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`FAIL ${symbol}:`, error instanceof Error ? error.message : error);
  }
}
