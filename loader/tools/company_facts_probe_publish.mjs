// One-shot probe publisher for options.company_facts.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_COMPANY_FACTS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/company_facts_probe_publish.mjs AAPL MSFT

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
  console.error("usage: node tools/company_facts_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_COMPANY_FACTS_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_COMPANY_FACTS_URL is required");
  process.exit(1);
}

const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();
const rows = symbols.map((ticker) => ({
  ticker,
  security_id: securityIdForTicker(ticker),
  cik: ticker === "AAPL" ? "0000320193" : "0000789019",
  period_end: "2026-06-27",
  period_type: "Q3",
  fiscal_year: 2026,
  form: "10-Q",
  filed_at: "2026-07-31",
  frame: "CY2026Q2",
  revenue: 109_417_000_000,
  net_income: 29_789_000_000,
  operating_cash_flow: 27_000_000_000,
  diluted_eps: 2.02,
  share_based_compensation: 3_401_000_000,
  long_term_debt: 71_340_000_000,
  long_term_debt_current: 10_960_000_000,
  cash: 39_544_000_000,
  operating_lease_liability: 12_490_000_000,
  finance_lease_liability: 1_230_000_000,
  interest_expense: null,
  source: "edgar",
  run_id: runId,
  fetched_at: fetchedAt,
}));

const headers = {
  "content-type": "application/json",
  "user-agent": "cboe-to-r2/0.2",
};
if (auth) {
  headers.authorization = `Bearer ${auth}`;
  headers["idempotency-key"] = `company-facts-probe:${runId}`;
}

const body = JSON.stringify(
  rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }),
);

const res = await fetch(url, { method: "POST", headers, body });
const text = await res.text();
if (!res.ok) {
  console.error(`pipeline publish HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, published: rows.length, tickers: symbols, http: res.status }));
