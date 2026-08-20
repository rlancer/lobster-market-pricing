// One-shot probe publisher for options.reg_sho_daily.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_REG_SHO_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/reg_sho_probe_publish.mjs AAPL MSFT BRK.B

const symbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (symbols.length === 0) {
  console.error("usage: node tools/reg_sho_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_REG_SHO_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_REG_SHO_URL is required");
  process.exit(1);
}

const runId = `probe-${crypto.randomUUID()}`;
const fetchedAt = new Date().toISOString();
const tradeDate = "2026-08-18";

const rows = symbols.map((symbol, i) => {
  const short_volume = 400_000 + i * 10_000;
  const total_volume = 1_500_000 + i * 20_000;
  return {
    symbol,
    trade_date: tradeDate,
    short_volume,
    short_exempt_volume: 1_000,
    total_volume,
    short_ratio: short_volume / total_volume,
    facility_count: 3,
    source: "finra",
    run_id: runId,
    fetched_at: fetchedAt,
  };
});

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
  headers["idempotency-key"] = `reg_sho_probe:${runId}`;
}

const res = await fetch(url, { method: "POST", headers, body });
const text = await res.text();
if (!res.ok) {
  console.error(`pipeline HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, row_count: rows.length, run_id: runId, symbols }));
