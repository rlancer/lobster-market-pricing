/**
 * Ticker identity for Copilot trade suggestions / research.
 *
 * Resolution order (request path — lake first, no live Yahoo):
 *   1. D1 `ticker_identities` row (served even if TTL-stale)
 *   2. Lake `options.securities` latest-wins row
 *   3. Deterministic ticker-derived identity (always succeeds)
 *
 * OpenFIGI Mapping API is opt-in (`liveFigi: true`) and must not sit on the
 * research-brief critical path. security_id is ticker-seeded UUID so rows join
 * the lake even when FIGI enrichment is missing. figi / composite_figi / isin
 * are enrichment columns (same posture as `loader/tools/figi_map.ts`).
 */

import { normalizeTicker, securityIdForTicker } from "./symbology";

export const OPEN_FIGI_ENDPOINT = "https://api.openfigi.com/v3/mapping";
export const IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FigiEnv {
  SCHEMA_DB: D1Database;
  OPEN_FIGI?: string;
}

export interface TickerIdentity {
  security_id: string;
  ticker: string;
  figi: string | null;
  composite_figi: string | null;
  isin: string | null;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  source: "openfigi" | "lake" | "ticker" | "cache";
  resolved_at: number;
}

interface OpenFigiEntry {
  figi?: string;
  compositeFIGI?: string;
  isin?: string;
  name?: string;
  ticker?: string;
  exchCode?: string;
  currency?: string;
  marketSector?: string;
}

export interface LakeSecurityRow {
  security_id?: unknown;
  ticker?: unknown;
  figi?: unknown;
  composite_figi?: unknown;
  isin?: unknown;
  name?: unknown;
  exchange?: unknown;
  currency?: unknown;
  sector?: unknown;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function identityFromRow(row: {
  security_id: string;
  ticker: string;
  figi: string | null;
  composite_figi: string | null;
  isin: string | null;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  source: string;
  resolved_at: number;
}): TickerIdentity {
  const source =
    row.source === "openfigi" || row.source === "lake" || row.source === "ticker" || row.source === "cache"
      ? row.source
      : "cache";
  return {
    security_id: row.security_id,
    ticker: row.ticker,
    figi: row.figi,
    composite_figi: row.composite_figi,
    isin: row.isin,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    sector: row.sector,
    source,
    resolved_at: row.resolved_at,
  };
}

export async function readCachedIdentity(
  db: D1Database,
  ticker: string,
  now = Date.now(),
  ttlMs = IDENTITY_TTL_MS,
  opts?: { allowStale?: boolean },
): Promise<TickerIdentity | null> {
  const row = await db.prepare(
    `SELECT security_id, ticker, figi, composite_figi, isin, name, exchange, currency, sector, source, resolved_at
     FROM ticker_identities WHERE ticker = ?1 LIMIT 1`,
  ).bind(ticker).first<{
    security_id: string;
    ticker: string;
    figi: string | null;
    composite_figi: string | null;
    isin: string | null;
    name: string | null;
    exchange: string | null;
    currency: string | null;
    sector: string | null;
    source: string;
    resolved_at: number;
  }>();
  if (!row) return null;
  const stale = now - row.resolved_at > ttlMs;
  if (stale && !opts?.allowStale) return null;
  return { ...identityFromRow(row), source: "cache" };
}

export async function writeIdentity(db: D1Database, identity: TickerIdentity): Promise<void> {
  const source = identity.source === "cache" ? "ticker" : identity.source;
  await db.prepare(
    `INSERT INTO ticker_identities
      (ticker, security_id, figi, composite_figi, isin, name, exchange, currency, sector, source, resolved_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(ticker) DO UPDATE SET
       security_id = excluded.security_id,
       figi = excluded.figi,
       composite_figi = excluded.composite_figi,
       isin = excluded.isin,
       name = excluded.name,
       exchange = excluded.exchange,
       currency = excluded.currency,
       sector = excluded.sector,
       source = excluded.source,
       resolved_at = excluded.resolved_at`,
  ).bind(
    identity.ticker,
    identity.security_id,
    identity.figi,
    identity.composite_figi,
    identity.isin,
    identity.name,
    identity.exchange,
    identity.currency,
    identity.sector,
    source,
    identity.resolved_at,
  ).run();
}

/** Map one ticker through OpenFIGI. Returns null on miss / error / no key. */
export async function mapOpenFigi(
  ticker: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenFigiEntry | null> {
  const res = await fetchImpl(OPEN_FIGI_ENDPOINT, {
    method: "POST",
    headers: {
      "X-OPENFIGI-APIKEY": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify([{ idType: "TICKER", idValue: ticker, exchCode: "US" }]),
  });
  if (!res.ok) throw new Error(`OpenFIGI HTTP ${res.status}`);
  const payload: unknown = await res.json();
  if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== "object") return null;
  const entry = payload[0] as { data?: unknown; error?: unknown };
  if (entry.error || !Array.isArray(entry.data) || !entry.data[0]) return null;
  const first = entry.data[0];
  return first && typeof first === "object" ? (first as OpenFigiEntry) : null;
}

export function identityFromOpenFigi(inputTicker: string, entry: OpenFigiEntry, now = Date.now()): TickerIdentity {
  const canonical = normalizeTicker(entry.ticker ?? inputTicker);
  return {
    security_id: securityIdForTicker(canonical),
    ticker: canonical,
    figi: str(entry.figi),
    composite_figi: str(entry.compositeFIGI),
    isin: str(entry.isin),
    name: str(entry.name),
    exchange: str(entry.exchCode),
    currency: str(entry.currency),
    sector: str(entry.marketSector),
    source: "openfigi",
    resolved_at: now,
  };
}

export function identityFromLake(row: LakeSecurityRow, fallbackTicker: string, now = Date.now()): TickerIdentity {
  const ticker = normalizeTicker(str(row.ticker) ?? fallbackTicker);
  const securityId = str(row.security_id) ?? securityIdForTicker(ticker);
  return {
    security_id: securityId,
    ticker,
    figi: str(row.figi),
    composite_figi: str(row.composite_figi),
    isin: str(row.isin),
    name: str(row.name),
    exchange: str(row.exchange),
    currency: str(row.currency),
    sector: str(row.sector),
    source: "lake",
    resolved_at: now,
  };
}

export function identityFromTicker(ticker: string, now = Date.now()): TickerIdentity {
  const normalized = normalizeTicker(ticker);
  return {
    security_id: securityIdForTicker(normalized),
    ticker: normalized,
    figi: null,
    composite_figi: null,
    isin: null,
    name: null,
    exchange: null,
    currency: null,
    sector: null,
    source: "ticker",
    resolved_at: now,
  };
}

export type LakeLookup = (ticker: string) => Promise<LakeSecurityRow | null>;

/**
 * Resolve a free-form ticker to a normalized identity. Always returns a row.
 * Default path is D1 (including stale) → lake → ticker. OpenFIGI is opt-in
 * via `liveFigi` and is skipped on the research brief so first paint is not
 * gated on a third-party HTTP round-trip.
 */
export async function resolveTickerIdentity(
  env: FigiEnv,
  rawTicker: string,
  opts?: {
    lakeLookup?: LakeLookup;
    fetchImpl?: typeof fetch;
    now?: number;
    persist?: boolean;
    /** When true, call OpenFIGI if D1+lake did not produce a row. Default false. */
    liveFigi?: boolean;
  },
): Promise<TickerIdentity> {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) throw new Error("ticker is required");
  const now = opts?.now ?? Date.now();
  const persist = opts?.persist !== false;

  const cached = await readCachedIdentity(env.SCHEMA_DB, ticker, now, IDENTITY_TTL_MS, { allowStale: true }).catch(() => null);
  if (cached) return cached;

  let resolved: TickerIdentity | null = null;

  if (opts?.lakeLookup) {
    try {
      const lake = await opts.lakeLookup(ticker);
      if (lake) resolved = identityFromLake(lake, ticker, now);
    } catch (e) {
      console.error("lake securities lookup failed", e);
    }
  }

  if (!resolved && opts?.liveFigi) {
    const key = env.OPEN_FIGI?.trim();
    if (key) {
      try {
        const entry = await mapOpenFigi(ticker, key, opts?.fetchImpl ?? fetch);
        if (entry) resolved = identityFromOpenFigi(ticker, entry, now);
      } catch (e) {
        console.error("OpenFIGI resolve failed", e);
      }
    }
  }

  if (!resolved) resolved = identityFromTicker(ticker, now);

  if (persist) {
    try {
      await writeIdentity(env.SCHEMA_DB, resolved);
      // Also index under the input ticker when OpenFIGI remapped it (e.g. alias).
      if (resolved.ticker !== ticker) {
        await writeIdentity(env.SCHEMA_DB, { ...resolved, ticker });
      }
    } catch (e) {
      console.error("ticker identity persist failed", e);
    }
  }

  return resolved;
}
