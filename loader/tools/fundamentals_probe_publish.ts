// One-shot probe publisher for options.fundamentals.
// Publishes synthetic rows (no Yahoo fetch) so CI can assert the stream→sink
// path without depending on Yahoo availability.
//
//   PIPELINE_FUNDAMENTALS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/fundamentals_probe_publish.ts AAPL MSFT GOOGL

import { securityIdForTicker } from "../src/symbology.ts";
import { FUNDAMENTALS_FIELDS, FUNDAMENTALS_SOURCE } from "../src/fundamentals.ts";

const symbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (symbols.length === 0) {
  console.error("usage: node tools/fundamentals_probe_publish.ts <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_FUNDAMENTALS_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_FUNDAMENTALS_URL is required");
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
const rows = symbols.map((ticker) => {
  const rec: Record<string, unknown> = {
    ticker,
    security_id: securityIdForTicker(ticker),
    market_cap: ticker === "AAPL" ? 3_500_000_000_000 : 2_000_000_000_000,
    enterprise_value: 3_600_000_000_000,
    trailing_pe: 32.1,
    forward_pe: 28.4,
    peg_ratio: 2.1,
    price_to_book: 45.5,
    total_debt: 100_000_000_000,
    debt_to_equity: 150.2,
    profit_margins: 0.25,
    revenue_growth: 0.08,
    source: FUNDAMENTALS_SOURCE,
    fetched_at: fetchedAt,
  };
  const out: Record<string, unknown> = {};
  for (const f of FUNDAMENTALS_FIELDS) out[f] = rec[f];
  return out;
});

const headers: Record<string, string> = {
  "content-type": "application/json",
  "user-agent": "cboe-to-r2/0.2",
};
if (auth) {
  headers.authorization = `Bearer ${auth}`;
  headers["idempotency-key"] = `fundamentals-probe:${fetchedAt}`;
}

const res = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(rows),
});
const text = await res.text();
if (!res.ok) {
  console.error(`pipeline publish HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, published: rows.length, tickers: symbols, http: res.status }));
