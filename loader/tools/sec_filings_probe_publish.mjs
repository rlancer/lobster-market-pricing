// One-shot probe publisher for options.sec_filings.
// Self-contained (no src/ imports) so CI can run it with plain `node` —
// Workers/vitest resolve .js→.ts; Node 24 strip-types does not.
//
//   PIPELINE_SEC_FILINGS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/sec_filings_probe_publish.mjs AAPL SPY IBIT

const FNV1A_OFFSET_HI = 0xcbf29ce484222325n;
const FNV1A_OFFSET_LO = 0x84222325cbf29ce4n;
const FNV1A_PRIME = 0x100000001b3n;
const OFFSET_BASIS = 0xcbf29ce484222325n;
const MASK = 0xffffffffffffffffn;

const EQUITY_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A"]);
const PROSPECTUS_FORMS = new Set([
  "N-1A", "N-1A/A", "485BPOS", "485APOS", "485BXT", "497", "497K",
]);
const ETF_TICKERS = new Set(["SPY", "IBIT", "QQQ", "IWM", "DIA", "VOO", "VTI"]);

const SEC_UA = "LobsterMarketPricing/0.1 (research; contact: rob@lobster.mp)";

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

function padCik(cik) {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function edgarUrl(cik, accession, primaryDocument) {
  const cikNum = String(Number(padCik(cik)));
  const folder = String(accession).replace(/-/g, "");
  const doc = (primaryDocument || "").trim();
  if (doc) return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${folder}/${doc}`;
  return `https://www.sec.gov/Archives/edgar/data/${cikNum}/${folder}/`;
}

function filingKind(form, isEtf) {
  const f = String(form || "").trim().toUpperCase();
  if (isEtf && PROSPECTUS_FORMS.has(f)) return "prospectus";
  if (EQUITY_FORMS.has(f)) return "filing";
  return null;
}

async function secGet(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": SEC_UA,
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SEC HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

async function loadCikMap() {
  const payload = await secGet("https://www.sec.gov/files/company_tickers.json");
  const map = new Map();
  for (const row of Object.values(payload || {})) {
    const ticker = String(row?.ticker || "").trim().toUpperCase();
    const cik = row?.cik_str ?? row?.cik;
    if (ticker && cik != null) map.set(ticker, padCik(cik));
  }
  return map;
}

function parseFilings(payload, ticker, cik, isEtf, runId, fetchedAt, max = 20) {
  const recent = payload?.filings?.recent;
  if (!recent) return [];
  const accessions = recent.accessionNumber || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const forms = recent.form || [];
  const primaryDocs = recent.primaryDocument || [];
  const descriptions = recent.primaryDocDescription || [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < accessions.length; i++) {
    const form = String(forms[i] || "").trim().toUpperCase();
    const kind = filingKind(form, isEtf);
    if (!kind) continue;
    const accession = String(accessions[i] || "").trim();
    if (!accession || seen.has(accession)) continue;
    seen.add(accession);
    const filedAt = String(filingDates[i] || "").trim();
    if (!filedAt) continue;
    const primaryDocument = String(primaryDocs[i] || "").trim() || null;
    out.push({
      ticker,
      security_id: securityIdForTicker(ticker),
      cik,
      form_type: form,
      accession,
      filed_at: filedAt,
      report_date: String(reportDates[i] || "").trim() || null,
      primary_document: primaryDocument,
      description: String(descriptions[i] || "").trim() || null,
      edgar_url: edgarUrl(cik, accession, primaryDocument),
      kind,
      source: "edgar",
      run_id: runId,
      fetched_at: fetchedAt,
    });
    if (out.length >= max) break;
  }
  return out;
}

const symbols = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
if (symbols.length === 0) {
  console.error("usage: node tools/sec_filings_probe_publish.mjs <SYMBOL> [SYMBOL ...]");
  process.exit(1);
}

const url = process.env.PIPELINE_SEC_FILINGS_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";
if (!url) {
  console.error("PIPELINE_SEC_FILINGS_URL is required");
  process.exit(1);
}

const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();
const cikMap = await loadCikMap();
const allRows = [];

for (const ticker of symbols) {
  const cik = cikMap.get(ticker);
  if (!cik) {
    console.warn(JSON.stringify({ ticker, published: false, reason: "no_cik" }));
    continue;
  }
  const isEtf = ETF_TICKERS.has(ticker);
  const payload = await secGet(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const rows = parseFilings(payload, ticker, cik, isEtf, runId, fetchedAt);
  console.log(JSON.stringify({ ticker, cik: "set", row_count: rows.length, isEtf }));
  allRows.push(...rows);
  // Be polite to SEC fair-access (~10 rps).
  await new Promise((r) => setTimeout(r, 200));
}

if (allRows.length === 0) {
  console.error("no filing rows to publish");
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  "user-agent": "cboe-to-r2/0.2",
};
if (auth) {
  headers.authorization = `Bearer ${auth}`;
  headers["idempotency-key"] = `sec-filings-probe:${runId}`;
}

// Strip nulls (pipeline schema optional fields).
const body = JSON.stringify(
  allRows.map((row) => {
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
  console.error(`pipeline HTTP ${res.status}: ${text.slice(0, 400)}`);
  process.exit(1);
}
console.log(JSON.stringify({ published: true, row_count: allRows.length, run_id: runId, status: res.status }));
