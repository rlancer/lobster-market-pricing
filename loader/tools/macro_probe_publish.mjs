// One-shot probe publisher for options.macro.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_MACRO_URL=... PIPELINE_AUTH_TOKEN=... FRED_API_KEY=... \
//     node tools/macro_probe_publish.mjs CPIAUCSL CPIAUCSL_YOY PCEPILFE PPIFIS

const SERIES = {
  CPIAUCSL: {
    title: "CPI All Urban Consumers: All Items (SA)",
    kind: "cpi",
    units: "index",
    frequency: "monthly",
  },
  CPILFESL: {
    title: "CPI All Urban Consumers: All Items Less Food and Energy (SA)",
    kind: "cpi",
    units: "index",
    frequency: "monthly",
  },
  CPIAUCSL_YOY: {
    title: "CPI All Items YoY %",
    kind: "cpi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "CPIAUCSL",
    fred_units: "pc1",
  },
  CPILFESL_YOY: {
    title: "Core CPI YoY %",
    kind: "cpi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "CPILFESL",
    fred_units: "pc1",
  },
  PCEPI: {
    title: "Personal Consumption Expenditures: Chain-type Price Index",
    kind: "pce",
    units: "index",
    frequency: "monthly",
  },
  PCEPILFE: {
    title: "PCE Excluding Food and Energy (Chain-type Price Index)",
    kind: "pce",
    units: "index",
    frequency: "monthly",
  },
  PCEPI_YOY: {
    title: "PCE Price Index YoY %",
    kind: "pce",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PCEPI",
    fred_units: "pc1",
  },
  PCEPILFE_YOY: {
    title: "Core PCE YoY %",
    kind: "pce",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PCEPILFE",
    fred_units: "pc1",
  },
  PPIFIS: {
    title: "Producer Price Index by Commodity: Final Demand",
    kind: "ppi",
    units: "index",
    frequency: "monthly",
  },
  PPIFIS_YOY: {
    title: "PPI Final Demand YoY %",
    kind: "ppi",
    units: "yoy_pct",
    frequency: "monthly",
    fred_series_id: "PPIFIS",
    fred_units: "pc1",
  },
};

const LOOKBACK_DAYS = 400;
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
  const meta = SERIES[seriesId];
  if (!meta) throw new Error(`unknown series ${seriesId}`);
  const now = Date.now();
  const start = isoDate(now - LOOKBACK_DAYS * 86400000);
  const end = isoDate(now);
  const fredId = meta.fred_series_id || seriesId;
  const units = meta.fred_units || "lin";
  const url =
    `${FRED_URL}?api_key=${encodeURIComponent(apiKey)}&file_type=json` +
    `&series_id=${encodeURIComponent(fredId)}` +
    `&units=${encodeURIComponent(units)}` +
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
      kind: meta.kind,
      units: meta.units,
      frequency: meta.frequency,
      source: "fred",
      run_id: runId,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

async function publish(seriesId, env) {
  const payload = await fetchSeries(seriesId, env.FRED_API_KEY);
  const rows = parseRows(seriesId, payload, env.runId, env.fetchedAt);
  if (rows.length === 0) {
    console.log(`${seriesId}: 0 rows — skip`);
    return;
  }
  const res = await fetch(env.PIPELINE_MACRO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "cboe-to-r2/0.2",
      "idempotency-key": `macro-probe:${env.runId}:${seriesId}`,
      authorization: `Bearer ${env.PIPELINE_AUTH_TOKEN}`,
    },
    body: JSON.stringify(stripNones(rows)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${seriesId} pipeline HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  console.log(`${seriesId}: published ${rows.length} rows`);
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("Usage: node tools/macro_probe_publish.mjs SERIES_ID [SERIES_ID…]");
  process.exit(2);
}
for (const id of ids) {
  if (!SERIES[id]) {
    console.error(`unknown series ${id}`);
    process.exit(2);
  }
}

const env = {
  PIPELINE_MACRO_URL: process.env.PIPELINE_MACRO_URL || "",
  PIPELINE_AUTH_TOKEN: process.env.PIPELINE_AUTH_TOKEN || "",
  FRED_API_KEY: process.env.FRED_API_KEY || "",
  runId: crypto.randomUUID(),
  fetchedAt: new Date().toISOString(),
};
if (!env.PIPELINE_MACRO_URL || !env.PIPELINE_AUTH_TOKEN || !env.FRED_API_KEY) {
  console.error("PIPELINE_MACRO_URL, PIPELINE_AUTH_TOKEN, and FRED_API_KEY are required");
  process.exit(2);
}

for (const id of ids) {
  await publish(id, env);
}
