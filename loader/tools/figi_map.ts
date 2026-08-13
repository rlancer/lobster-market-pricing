// OpenFIGI symbology mapper for the merged universe (S&P 500 + Nasdaq-100
// delta + major ETFs).
//
// Resolves each ticker via the OpenFIGI Mapping API and publishes two stream
// payloads:
//   - options.securities      — one row per current ticker (security master)
//   - options.symbol_history  — a current (`is_current=1`) row per ticker, plus
//     a rename row when OpenFIGI resolves an input ticker to a DIFFERENT
//     canonical ticker under the same composite FIGI.
//
// security_id is the DETERMINISTIC ticker-derived id (symbology.ts) so every
// writer (figi_map, the backfill job, the corporate-actions path) projects the
// same id for the same ticker. The OpenFIGI-native ids (figi / composite_figi /
// isin) are stored as enrichment columns on the securities row. Rename
// continuity is expressed through symbol_history rows, not by mutating
// security_id. Name/sector fall back to universe.json constituents when
// OpenFIGI does not resolve a ticker.
//
// Usage (from loader/; OPEN_FIGI + PIPELINE_*_URL + PIPELINE_AUTH_TOKEN in env):
//   node tools/figi_map.ts
//
// Reads symbols from symbols/universe.json. --limit N trims the universe for tests.

import { securityIdForTicker } from "../src/symbology.ts";
import universeData from "../symbols/universe.json" with { type: "json" };

const SYMBOLS: string[] = Array.isArray(universeData.symbols) ? universeData.symbols : [];
const CONSTITUENTS = (universeData.constituents ?? {}) as Record<
  string,
  { name?: string; sector?: string }
>;

const OPEN_FIGI_ENDPOINT = "https://api.openfigi.com/v3/mapping";
const BATCH = 100;

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : SYMBOLS.length;
const universe = SYMBOLS.slice(0, Math.max(1, limit));

interface OpenFigiEntry {
  figi?: string;
  compositeFIGI?: string;
  uniqueID?: string;
  isin?: string;
  name?: string;
  ticker?: string;
  exchCode?: string;
  marketSector?: string;
  currency?: string;
  securityDescription?: string;
}

function envStr(key: string): string {
  return process.env[key] ?? "";
}

function dateStr(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map a batch of tickers through OpenFIGI, returning the first entry per symbol
// (or undefined when OpenFIGI could not resolve it / returned an error).
async function mapBatch(tickers: string[], key: string): Promise<Array<OpenFigiEntry | undefined>> {
  const jobs = tickers.map((ticker) => ({ idType: "TICKER", idValue: ticker, exchCode: "US" }));
  const res = await fetch(OPEN_FIGI_ENDPOINT, {
    method: "POST",
    headers: { "X-OPENFIGI-APIKEY": key, "content-type": "application/json" },
    body: JSON.stringify(jobs),
  });
  if (!res.ok) throw new Error(`OpenFIGI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload: unknown = await res.json();
  if (!Array.isArray(payload)) throw new Error("OpenFIGI returned a non-array payload");
  return payload.map((entry) => {
    if (entry && typeof entry === "object" && "data" in entry) {
      const data = (entry as { data?: unknown }).data;
      const first = Array.isArray(data) ? data[0] : undefined;
      if (first && typeof first === "object") return first as OpenFigiEntry;
    }
    return undefined;
  });
}

async function publish(url: string, auth: string, records: Record<string, unknown>[], keyTag: string): Promise<void> {
  if (!url || records.length === 0) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", "user-agent": "cboe-to-r2/0.2" },
    body: JSON.stringify(records),
  });
  if (!res.ok) throw new Error(`pipeline ${keyTag} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const key = envStr("OPEN_FIGI");
const securitiesUrl = envStr("PIPELINE_SECURITIES_URL");
const historyUrl = envStr("PIPELINE_SYMBOL_HISTORY_URL");
const auth = envStr("PIPELINE_AUTH_TOKEN");
if (!key) console.error("WARNING: OPEN_FIGI not set — mapping will return errors for all symbols.");
if (!securitiesUrl) console.error("WARNING: PIPELINE_SECURITIES_URL not set — securities not published.");

const runId = crypto.randomUUID();
const fetchedAt = new Date().toISOString();
const asOfDate = fetchedAt.slice(0, 10);
const validFrom = dateStr(730); // ~2y backfill window start

const securities: Record<string, unknown>[] = [];
const history: Record<string, unknown>[] = [];
const unresolved: string[] = [];

for (let i = 0; i < universe.length; i += BATCH) {
  if (i > 0) await sleep(250);
  const slice = universe.slice(i, i + BATCH);
  const entries = await mapBatch(slice, key);
  entries.forEach((entry, idx) => {
    const ticker = slice[idx];
    const cons = CONSTITUENTS[ticker] ?? {};
    const resolved = typeof entry?.ticker === "string" ? entry.ticker.trim().toUpperCase() : ticker;
    const composite = typeof entry?.compositeFIGI === "string" ? entry.compositeFIGI.trim() : "";
    const figi = typeof entry?.figi === "string" ? entry.figi.trim() : "";
    const isin = typeof entry?.isin === "string" ? entry.isin.trim() : "";
    const figiName = typeof entry?.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : (typeof entry?.securityDescription === "string" ? entry.securityDescription.trim() : "");
    const name = figiName || (typeof cons.name === "string" ? cons.name : "") || ticker;
    const exchange = typeof entry?.exchCode === "string" ? entry.exchCode : "";
    const figiSector = typeof entry?.marketSector === "string" ? entry.marketSector : "";
    const sector = figiSector || (typeof cons.sector === "string" ? cons.sector : "") || "";
    const currency = typeof entry?.currency === "string" ? entry.currency : "";
    if (!figi) unresolved.push(ticker);

    const sid = securityIdForTicker(resolved === ticker ? ticker : resolved);
    securities.push({
      security_id: sid, ticker, name, sector, exchange, currency,
      figi, composite_figi: composite || null, isin,
      run_id: runId, as_of_date: asOfDate, fetched_at: fetchedAt,
    });
    // Current ticker row.
    history.push({
      security_id: sid, ticker, valid_from: validFrom, valid_to: null, is_current: 1,
      reason: "add", run_id: runId, fetched_at: fetchedAt,
    });
    // Rename: OpenFIGI resolved this input ticker to a DIFFERENT canonical
    // ticker — record a historical row for the input ticker pointing at the
    // canonical security so backfill can join across the rename.
    if (resolved && resolved !== ticker) {
      history.push({
        security_id: sid, ticker, valid_from: validFrom, valid_to: asOfDate, is_current: 0,
        reason: "rename", run_id: runId, fetched_at: fetchedAt,
      });
    }
  });
}

await publish(securitiesUrl, auth, securities, "securities");
await publish(historyUrl, auth, history, "symbol_history");

console.log(JSON.stringify({
  mapped: securities.length, history_rows: history.length, run_id: runId,
  unresolved_figi: unresolved.length, unresolved_tickers: unresolved,
  securities_published: Boolean(securitiesUrl) && securities.length > 0,
  history_published: Boolean(historyUrl) && history.length > 0,
}, null, 2));
