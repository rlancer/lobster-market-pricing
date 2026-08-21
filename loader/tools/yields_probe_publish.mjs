// One-shot probe publisher for options.yields.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_YIELDS_URL=... PIPELINE_AUTH_TOKEN=... FRED_API_KEY=... \
//     node tools/yields_probe_publish.mjs DGS10 T10Y2Y SOFR

const SERIES = {
  DGS1MO: { title: "1-Month Treasury Constant Maturity", tenor: "1M", kind: "nominal" },
  DGS3MO: { title: "3-Month Treasury Constant Maturity", tenor: "3M", kind: "nominal" },
  DGS6MO: { title: "6-Month Treasury Constant Maturity", tenor: "6M", kind: "nominal" },
  DGS1: { title: "1-Year Treasury Constant Maturity", tenor: "1Y", kind: "nominal" },
  DGS2: { title: "2-Year Treasury Constant Maturity", tenor: "2Y", kind: "nominal" },
  DGS3: { title: "3-Year Treasury Constant Maturity", tenor: "3Y", kind: "nominal" },
  DGS5: { title: "5-Year Treasury Constant Maturity", tenor: "5Y", kind: "nominal" },
  DGS7: { title: "7-Year Treasury Constant Maturity", tenor: "7Y", kind: "nominal" },
  DGS10: { title: "10-Year Treasury Constant Maturity", tenor: "10Y", kind: "nominal" },
  DGS20: { title: "20-Year Treasury Constant Maturity", tenor: "20Y", kind: "nominal" },
  DGS30: { title: "30-Year Treasury Constant Maturity", tenor: "30Y", kind: "nominal" },
  T10Y2Y: { title: "10-Year Treasury Minus 2-Year Treasury", tenor: null, kind: "spread" },
  T10Y3M: { title: "10-Year Treasury Minus 3-Month Treasury", tenor: null, kind: "spread" },
  T5YIE: { title: "5-Year Breakeven Inflation Rate", tenor: "5Y", kind: "breakeven" },
  T10YIE: { title: "10-Year Breakeven Inflation Rate", tenor: "10Y", kind: "breakeven" },
  DFII5: { title: "5-Year Treasury Inflation-Indexed Security", tenor: "5Y", kind: "real" },
  DFII10: { title: "10-Year Treasury Inflation-Indexed Security", tenor: "10Y", kind: "real" },
  DFF: { title: "Federal Funds Effective Rate", tenor: "ON", kind: "policy" },
  SOFR: { title: "Secured Overnight Financing Rate", tenor: "ON", kind: "policy" },
};

const LOOKBACK_DAYS = 90;
const FRED_URL = "https://api.stlouisfed.org/fred/series/observations";

function isoDate(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function stripNones(value) {
  if (Array.isArray(value)) return value.map(stripNones);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined) out[k] = stripNones(v);
    }
    return out;
  }
  return value;
}

async function fetchSeries(seriesId, apiKey) {
  const now = Date.now();
  const start = isoDate(now - LOOKBACK_DAYS * 86400000);
  const end = isoDate(now);
  const url =
    `${FRED_URL}?api_key=${encodeURIComponent(apiKey)}&file_type=json` +
    `&series_id=${encodeURIComponent(seriesId)}` +
    `&observation_start=${start}&observation_end=${end}&sort_order=asc`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FRED HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

function parseRows(seriesId, payload, runId, fetchedAt) {
  const meta = SERIES[seriesId];
  if (!meta) throw new Error(`unknown series ${seriesId}`);
  const out = [];
  for (const raw of payload?.observations || []) {
    const date = String(raw?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const rawVal = String(raw?.value ?? "").trim();
    if (!rawVal || rawVal === ".") continue;
    const value = Number(rawVal);
    if (!Number.isFinite(value)) continue;
    out.push({
      series_id: seriesId,
      date,
      value,
      title: meta.title,
      tenor: meta.tenor,
      kind: meta.kind,
      source: "fred",
      run_id: runId,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

async function publish(url, token, rows, idempotencyKey) {
  const headers = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
    "idempotency-key": idempotencyKey,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(stripNones(rows)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pipeline HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

const pipelineUrl = process.env.PIPELINE_YIELDS_URL || "";
const authToken = process.env.PIPELINE_AUTH_TOKEN || "";
const fredKey = process.env.FRED_API_KEY || "";
if (!pipelineUrl) {
  console.error("PIPELINE_YIELDS_URL not set");
  process.exit(1);
}
if (!fredKey) {
  console.error("FRED_API_KEY not set");
  process.exit(1);
}

const ids = process.argv.slice(2);
const seriesIds = ids.length > 0 ? ids : ["DGS10", "T10Y2Y", "SOFR", "DFF"];
const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();

for (const seriesId of seriesIds) {
  if (!SERIES[seriesId]) {
    console.error(`unknown series ${seriesId}`);
    process.exit(1);
  }
  const payload = await fetchSeries(seriesId, fredKey);
  const rows = parseRows(seriesId, payload, runId, fetchedAt);
  if (rows.length === 0) {
    console.log(JSON.stringify({ series_id: seriesId, row_count: 0, published: false }));
    continue;
  }
  await publish(pipelineUrl, authToken, rows, `yields:${runId}:${seriesId}`);
  const last = rows[rows.length - 1];
  console.log(JSON.stringify({
    series_id: seriesId,
    row_count: rows.length,
    published: true,
    last: { date: last.date, value: last.value },
  }));
}
