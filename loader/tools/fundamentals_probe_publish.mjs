// One-shot probe publisher for options.fundamentals.
// Self-contained (no src/ imports) so CI can run it with plain `node` —
// Workers/vitest resolve .js→.ts; Node 24 strip-types does not.
//
//   PIPELINE_FUNDAMENTALS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/fundamentals_probe_publish.mjs AAPL MSFT GOOGL

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
  console.error("usage: node tools/fundamentals_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_FUNDAMENTALS_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_FUNDAMENTALS_URL is required");
  process.exit(1);
}

const fetchedAt = new Date().toISOString();
const rows = symbols.map((ticker) => ({
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
  source: "yahoo",
  fetched_at: fetchedAt,
}));

const headers = {
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
