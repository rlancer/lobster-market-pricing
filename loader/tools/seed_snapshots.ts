// Populate options.underlying_snapshots by running the real CBOE refresh path
// locally (runSymbols), which now dual-publishes underlyings (back-compat) and
// underlying_snapshots. Used once at cutover to give the repointed screener
// data outside market hours; the deployed cboe-options job keeps it fresh.
//
// Usage (from loader/, with PIPELINE_*_URL + PIPELINE_AUTH_TOKEN in env):
//   node tools/seed_snapshots.ts [--limit N]
import { runSymbols } from "../src/run-symbols.ts";
import sp500 from "../symbols/sp500.json" with { type: "json" };

const SYMBOLS: string[] = Array.isArray(sp500.symbols) ? sp500.symbols : [];
const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const offsetIdx = argv.indexOf("--offset");
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : SYMBOLS.length;
const offset = offsetIdx >= 0 ? Number(argv[offsetIdx + 1]) : 0;
const universe = SYMBOLS.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));

const env = {
  PIPELINE_RUNS_URL: process.env.PIPELINE_RUNS_URL || "",
  PIPELINE_CONTRACTS_URL: process.env.PIPELINE_CONTRACTS_URL || "",
  PIPELINE_UNDERLYINGS_URL: process.env.PIPELINE_UNDERLYINGS_URL || "",
  PIPELINE_UNDERLYING_SNAPSHOTS_URL: process.env.PIPELINE_UNDERLYING_SNAPSHOTS_URL || "",
  PIPELINE_ERRORS_URL: process.env.PIPELINE_ERRORS_URL || "",
  PIPELINE_AUTH_TOKEN: process.env.PIPELINE_AUTH_TOKEN || "",
  HTTP_RETRIES: process.env.HTTP_RETRIES || "3",
  SYMBOL_CONCURRENCY: process.env.SYMBOL_CONCURRENCY || "8",
  SYMBOL_DELAY_SECONDS: process.env.SYMBOL_DELAY_SECONDS || "1",
};

console.log(`seeding ${universe.length} snapshots...`);
if (!env.PIPELINE_UNDERLYING_SNAPSHOTS_URL) {
  console.error("WARNING: PIPELINE_UNDERLYING_SNAPSHOTS_URL not set — snapshots will NOT be published.");
}
const result = await runSymbols(universe, env);
console.log(JSON.stringify({
  status: result.run.status,
  successful: result.run.successful_symbols,
  failed: result.run.failed_symbols,
  contract_count: result.run.contract_count,
  run_id: result.run.run_id,
  failures: result.failures.slice(0, 10),
}, null, 2));
process.exit((result.run.status === "complete" ? 0 : 2));
