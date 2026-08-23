// One-shot probe publisher for options.kalshi_markets.
// Self-contained (no src/ imports) so CI can run it with plain `node`.
//
//   PIPELINE_KALSHI_MARKETS_URL=... PIPELINE_AUTH_TOKEN=... \
//     node tools/kalshi_probe_publish.mjs KXFED KXCPI KXINX KXBTC

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "../symbols/kalshi-series.json"), "utf8"),
);

const API_BASE = (MANIFEST.api_base || "https://api.elections.kalshi.com/trade-api/v2").replace(/\/$/, "");
const DEFAULT_CAP = MANIFEST.max_markets_per_series_default || 80;
const SERIES_META = Object.fromEntries((MANIFEST.series || []).map((s) => [s.series_ticker, s]));

function secret(name) {
  if (process.env[name]) return process.env[name];
  try {
    const vars = readFileSync(join(ROOT, "../.dev.vars"), "utf8");
    const m = new RegExp(`^${name}=(\\S+)`, "m").exec(vars);
    return m ? m[1] : "";
  } catch {
    return "";
  }
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

function parseNum(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "cboe-to-r2/0.2" },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function publish(url, token, rows, idem) {
  const headers = {
    "content-type": "application/json",
    "user-agent": "cboe-to-r2/0.2",
    "idempotency-key": idem,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(stripNones(rows)),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`pipeline HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
}

async function loadSeries(seriesId) {
  const meta = SERIES_META[seriesId];
  if (!meta) throw new Error(`unknown series ${seriesId}`);
  let category = null;
  try {
    const s = await fetchJson(`${API_BASE}/series/${encodeURIComponent(seriesId)}`);
    category = s?.series?.category || s?.category || null;
  } catch {
    // optional
  }
  const markets = [];
  let cursor = "";
  for (let page = 0; page < 8; page++) {
    let url =
      `${API_BASE}/markets?series_ticker=${encodeURIComponent(seriesId)}` +
      `&status=open&limit=200`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const data = await fetchJson(url);
    for (const m of data.markets || []) {
      markets.push({
        series_ticker: seriesId,
        market_ticker: String(m.ticker || "").toUpperCase(),
        event_ticker: m.event_ticker || null,
        title: m.title || m.ticker,
        yes_subtitle: m.yes_sub_title || m.subtitle || null,
        theme: meta.theme,
        category,
        status: m.status || "unknown",
        market_type: m.market_type || null,
        yes_bid: parseNum(m.yes_bid_dollars ?? m.yes_bid),
        yes_ask: parseNum(m.yes_ask_dollars ?? m.yes_ask),
        yes_last: parseNum(m.last_price_dollars ?? m.last_price),
        no_bid: parseNum(m.no_bid_dollars ?? m.no_bid),
        no_ask: parseNum(m.no_ask_dollars ?? m.no_ask),
        volume: parseNum(m.volume_fp ?? m.volume),
        volume_24h: parseNum(m.volume_24h_fp ?? m.volume_24h),
        open_interest: parseNum(m.open_interest_fp ?? m.open_interest),
        liquidity: parseNum(m.liquidity_dollars ?? m.liquidity),
        floor_strike: parseNum(m.floor_strike),
        close_time: m.close_time || null,
        expiration_time: m.expiration_time || m.expected_expiration_time || null,
        related_symbol: meta.related_symbol,
        source: "kalshi",
      });
    }
    cursor = data.cursor || "";
    if (!cursor || !(data.markets || []).length) break;
  }
  markets.sort((a, b) => {
    const va = a.volume_24h ?? a.volume ?? 0;
    const vb = b.volume_24h ?? b.volume ?? 0;
    if (vb !== va) return vb - va;
    return String(a.close_time || "9999").localeCompare(String(b.close_time || "9999"));
  });
  const cap = meta.max_markets || DEFAULT_CAP;
  return markets.slice(0, cap);
}

const PIPELINE_KALSHI_MARKETS_URL = secret("PIPELINE_KALSHI_MARKETS_URL");
const PIPELINE_AUTH_TOKEN = secret("PIPELINE_AUTH_TOKEN");
if (!PIPELINE_KALSHI_MARKETS_URL) {
  console.error("PIPELINE_KALSHI_MARKETS_URL is required");
  process.exit(2);
}

const argv = process.argv.slice(2);
const targets = argv.length > 0 ? argv : Object.keys(SERIES_META).slice(0, 4);
const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();
const results = [];

for (const seriesId of targets) {
  try {
    const rows = await loadSeries(seriesId);
    if (rows.length === 0) {
      results.push({ item: seriesId, row_count: 0, published: false });
      continue;
    }
    const payload = rows.map((r) => ({ ...r, run_id: runId, fetched_at: fetchedAt }));
    await publish(PIPELINE_KALSHI_MARKETS_URL, PIPELINE_AUTH_TOKEN, payload, `kalshi:${runId}:${seriesId}`);
    results.push({ item: seriesId, row_count: rows.length, published: true });
  } catch (error) {
    results.push({
      item: seriesId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ run_id: runId, results }, null, 2));
