// One-shot probe publisher for options.short_interest.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_SHORT_INTEREST_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/short_interest_probe_publish.mjs AAPL MSFT BRK.B

const symbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (symbols.length === 0) {
  console.error("usage: node tools/short_interest_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_SHORT_INTEREST_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_SHORT_INTEREST_URL is required");
  process.exit(1);
}

const runId = `probe-${crypto.randomUUID()}`;
const fetchedAt = new Date().toISOString();
const settlementDate = "2026-07-31";

const rows = symbols.map((symbol, i) => ({
  symbol,
  settlement_date: settlementDate,
  short_interest: 100_000_000 + i * 1_000_000,
  prev_short_interest: 95_000_000 + i * 1_000_000,
  short_interest_change: 5_000_000,
  short_interest_change_pct: 5.26,
  avg_daily_volume: 50_000_000,
  days_to_cover: 2.1,
  market_class: "NNM",
  issue_name: `${symbol} probe`,
  revision_flag: null,
  stock_split_flag: null,
  source: "finra",
  run_id: runId,
  fetched_at: fetchedAt,
}));

const body = JSON.stringify(
  rows.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }),
);

const headers = {
  "content-type": "application/json",
  "user-agent": "cboe-to-r2/0.2",
};
if (auth) {
  headers.authorization = `Bearer ${auth}`;
  headers["idempotency-key"] = `short_interest_probe:${runId}`;
}

const res = await fetch(url, { method: "POST", headers, body });
const text = await res.text();
if (!res.ok) {
  console.error(`pipeline HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, row_count: rows.length, run_id: runId, symbols }));
