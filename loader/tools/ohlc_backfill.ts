// Local driver for the 2y S&P 500 OHLC backfill — resumable per-symbol.
//
// Usage (from loader/):
//   node tools/ohlc_backfill.ts [--concurrency N] [--limit N] [--symbol AAPL,MSFT]
//
// Reads Pipeline URLs/auth from the environment (LoaderEnv keys) and walks the
// S&P 500 universe through publishOhlcRange. Resumability is optional: use
// --state out.json to persist {symbol:status} and skip already-succeeded
// symbols on a re-run (useful if Yahoo throttles mid-run).
//
// The job-scoped path (/jobs/ohlc-backfill/trigger in the DO) is item-resumable
// via D1; this tool exists so a one-off local run can drive the same publish
// path without the scheduler. security_id is the deterministic ticker-derived
// id (symbology.ts), matching the scheduled job and figi_map.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { publishOhlcRange } from "../src/ohlc.ts";
import { securityIdForTicker } from "../src/symbology.ts";
import sp500 from "../symbols/sp500.json" with { type: "json" };

const SYMBOLS: string[] = Array.isArray(sp500.symbols) ? sp500.symbols : [];

function num(arg: string | undefined, dflt: number): number {
  const n = Number(arg);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function envLike(): Record<string, string> {
  return {
    PIPELINE_OHLC_URL: process.env.PIPELINE_OHLC_URL || "",
    PIPELINE_REALIZED_VOL_URL: process.env.PIPELINE_REALIZED_VOL_URL || "",
    PIPELINE_CORPORATE_ACTIONS_URL: process.env.PIPELINE_CORPORATE_ACTIONS_URL || "",
    PIPELINE_AUTH_TOKEN: process.env.PIPELINE_AUTH_TOKEN || "",
    HTTP_RETRIES: process.env.HTTP_RETRIES || process.env.OHLC_HTTP_RETRIES || "3",
  };
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const concurrency = Math.max(1, num(flag("--concurrency"), 4));
const limit = num(flag("--limit"), SYMBOLS.length);
const stateFile = flag("--state");
const explicit = (flag("--symbol") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const WINDOW_DAYS = 730;
const nowMs = Date.now();
const period2 = Math.floor(nowMs / 1000);
const period1 = period2 - WINDOW_DAYS * 86400;

const env = envLike();
if (!env.PIPELINE_OHLC_URL && !env.PIPELINE_REALIZED_VOL_URL && !env.PIPELINE_CORPORATE_ACTIONS_URL) {
  console.error("WARNING: no PIPELINE_*_URL set — running in DRY-RUN (fetch+normalize only, no publish).");
}

const universe = (explicit.length ? explicit : SYMBOLS).slice(0, limit);

let state = new Map<string, "ok" | "fail" | "skip">();
if (stateFile && existsSync(stateFile)) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed)) state.set(k, v as never);
    }
  } catch {
    /* corrupt state -> start fresh */
  }
}

const runId = crypto.randomUUID();
const envWithRun = { ...env, runId: () => runId };

let next = 0;
let ok = 0, failed = 0, skipped = 0;
const failures: Array<{ symbol: string; error: string }> = [];

async function worker(): Promise<void> {
  while (true) {
    const index = next++;
    if (index >= universe.length) return;
    const symbol = universe[index];
    if (state.get(symbol) === "ok") { skipped++; continue; }
    try {
      const result = await publishOhlcRange(symbol, period1, period2, envWithRun, securityIdForTicker(symbol));
      state.set(symbol, "ok");
      ok++;
      if (ok % 25 === 0 || ok === universe.length) {
        console.log(`progress ok=${ok} failed=${failed} skipped=${skipped} (${symbol}: ${result.bar_count} bars, ${result.corporate_action_count} corp actions)`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      state.set(symbol, "fail");
      failures.push({ symbol, error: msg });
      failed++;
      console.error(`FAIL ${symbol}: ${msg}`);
    }
    if (stateFile && (ok + failed) % 20 === 0) saveState();
  }
}

function saveState(): void {
  if (!stateFile) return;
  const obj: Record<string, string> = {};
  for (const [k, v] of state) obj[k] = v;
  writeFileSync(stateFile, JSON.stringify(obj, null, 2));
}

await Promise.all(Array.from({ length: Math.min(concurrency, universe.length) }, () => worker()));
saveState();

console.log(`\nbackfill complete: attempted=${universe.length} ok=${ok} failed=${failed} skipped=${skipped}`);
if (failures.length) {
  console.log(`failures (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.log(`  ${f.symbol}: ${f.error.slice(0, 120)}`);
}
process.exit(failed > 0 ? 2 : 0);
