// Live probe for the earnings-calendar path (Nasdaq → parse → S&P 500 filter).
// Dry-run: no PIPELINE_EARNINGS_URL, so it fetches + parses + filters only —
// nothing is published.
//   node tools/earnings_probe.ts            (next 14 calendar days)
//   node tools/earnings_probe.ts 2026-08-10 (one specific date)
import { readFileSync } from "node:fs";
import { fetchEarningsDate, parseNasdaqEarnings } from "../src/earnings.ts";

// Bare-node probe: read the manifest via fs (JSON imports need attributes
// outside a bundler; wrangler/vitest resolve them natively).
const sp500 = JSON.parse(
  readFileSync(new URL("../symbols/sp500.json", import.meta.url), "utf8"),
) as { symbols?: string[] };
const SYMBOLS = Array.isArray(sp500.symbols) ? sp500.symbols : [];
const KEEP = new Set(SYMBOLS.map((s) => s.toUpperCase()));

function dateForOffset(offset: number): string {
  const d = new Date(Date.now() + offset * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const args = process.argv.slice(2).filter(Boolean);
const dates = args.length > 0 ? args : Array.from({ length: 14 }, (_, i) => dateForOffset(i));

for (const date of dates) {
  try {
    const payload = await fetchEarningsDate(date, { HTTP_RETRIES: 2 });
    const rows = parseNasdaqEarnings(payload, date);
    const kept = rows.filter((r) => KEEP.has(r.symbol));
    console.log(JSON.stringify({
      date,
      calendar_rows: rows.length,
      sp500_rows: kept.length,
      sample: kept.slice(0, 5).map((r) => ({ symbol: r.symbol, time: r.time, eps_forecast: r.eps_forecast, est_count: r.est_count })),
    }));
  } catch (error) {
    console.error(`FAIL ${date}:`, error instanceof Error ? error.message : error);
  }
}