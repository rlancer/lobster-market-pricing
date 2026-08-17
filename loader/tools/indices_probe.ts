#!/usr/bin/env node
// Probe Yahoo chart OHLC for symbols/indices.json (vol-index sleeve).
import indices from "../symbols/indices.json" with { type: "json" };

const rows = Array.isArray(indices.indices) ? indices.indices : [];
const symbols = rows.map((r) => r.symbol);

console.log(`\n=== indices-ohlc-daily universe (${symbols.length}) ===`);
for (const symbol of symbols) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": "cboe-to-r2/0.2" } });
  if (!res.ok) {
    console.log(`${symbol} HTTP ${res.status}`);
    continue;
  }
  const payload = await res.json();
  const first = payload?.chart?.result?.[0];
  const meta = first?.meta ?? {};
  const bars = Array.isArray(first?.timestamp) ? first.timestamp.length : 0;
  console.log(
    `${symbol} ok type=${meta.instrumentType ?? "?"} px=${meta.regularMarketPrice ?? "?"} bars=${bars}`,
  );
}
