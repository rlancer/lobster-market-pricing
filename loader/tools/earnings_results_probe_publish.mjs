// One-shot probe publisher for options.earnings_results.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_EARNINGS_RESULTS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/earnings_results_probe_publish.mjs AAPL MSFT

const FNV1A_OFFSET_HI = 0xcbf29ce484222325n;
const FNV1A_OFFSET_LO = 0x84222325cbf29ce4n;
const FNV1A_PRIME = 0x100000001b3n;
const OFFSET_BASIS = 0xcbf29ce484222325n;
const MASK = 0xffffffffffffffffn;

function fnv1a64(input, offset) {
  let hash = offset;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV1A_PRIME) & MASK;
  }
  return hash;
}

function securityIdForTicker(ticker) {
  const seed = `ticker:${String(ticker).toUpperCase()}`;
  const hi = fnv1a64(seed, FNV1A_OFFSET_HI);
  const lo = fnv1a64(seed + ":" + OFFSET_BASIS.toString(16), FNV1A_OFFSET_LO);
  const hex = (hi.toString(16).padStart(16, "0") + lo.toString(16).padStart(16, "0")).toLowerCase();
  const s = (i) => hex[i] ?? "0";
  return (
    s(0) + s(1) + s(2) + s(3) + s(4) + s(5) + s(6) + s(7) + "-" +
    s(8) + s(9) + s(10) + s(11) + "-" +
    "4" + s(13) + s(14) + s(15) + "-" +
    "8" + s(17) + s(18) + s(19) + "-" +
    s(20) + s(21) + s(22) + s(23) + s(24) + s(25) + s(26) + s(27) +
    s(28) + s(29) + s(30) + s(31)
  );
}

const symbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (symbols.length === 0) {
  console.error("usage: node tools/earnings_results_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_EARNINGS_RESULTS_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_EARNINGS_RESULTS_URL is required");
  process.exit(1);
}

const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();
const rows = symbols.flatMap((symbol) => [
  {
    symbol,
    security_id: securityIdForTicker(symbol),
    quarter_end: "2025-09-30",
    period_label: "-1q",
    eps_actual: symbol === "AAPL" ? 1.85 : 2.1,
    eps_estimate: 1.77,
    eps_difference: 0.08,
    surprise_pct: 0.045,
    currency: "USD",
    source: "yahoo",
    run_id: runId,
    fetched_at: fetchedAt,
  },
  {
    symbol,
    security_id: securityIdForTicker(symbol),
    quarter_end: "2025-06-30",
    period_label: "-2q",
    eps_actual: 1.57,
    eps_estimate: 1.5,
    eps_difference: 0.07,
    surprise_pct: 0.046,
    currency: "USD",
    source: "yahoo",
    run_id: runId,
    fetched_at: fetchedAt,
  },
]);

const headers = {
  "content-type": "application/json",
  "user-agent": "cboe-to-r2/0.2",
};
if (auth) {
  headers.authorization = `Bearer ${auth}`;
  headers["idempotency-key"] = `earnings-results-probe:${runId}`;
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
