/**
 * Screener API — a thin Worker backend over the CBOE Iceberg lake (R2 SQL).
 *
 * The loader project (cboe-to-r2) owns ingestion: CBOE → Cloudflare Pipelines →
 * R2 Data Catalog Iceberg tables (options.option_contracts / options.underlyings /
 * options.refresh_runs). This Worker is the *consumer*: it runs the screener's
 * read-only analytics SQL against the lake over the R2 SQL REST API and returns
 * JSON. No DuckDB, no Parquet, no local download — the lake is the single source
 * of truth and the browser is a plain React client.
 *
 * Why this works: the dataset only changes on nightly loader runs, so query
 * results are cached aggressively (in-isolate Map, 5–10 min TTL). The first
 * request after a cold cache is ~1–6s (a handful of R2 SQL scans); cached
 * responses are instant.
 *
 * R2 SQL gotchas this accounts for:
 *  - No OFFSET: screen/underlyings fetch the ordered result (≤ R2 SQL's 10000-row
 *    LIMIT) once per filter signature and page slices in-memory from cache.
 *  - No parameter binding over REST: literals are inlined via lit() with
 *    single-quote escaping; sort columns are whitelisted.
 *  - DataFusion dialect: spot_price (not spot), WHERE before QUALIFY, DTE via
 *    CAST(expiration AS DATE) - CURRENT_DATE (returns integer days).
 */
import { copilotChat } from "./copilot";


// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
export interface Env {
  R2_SQL_ACCOUNT_ID: string;
  R2_SQL_BUCKET: string;
  R2_SQL_TOKEN: string; // secret
  CORS_ORIGIN?: string;
  // Tavily search API key (secret) for /api/news and /api/web_search. Stored
  // on the deployed Worker and mirrored as a GitHub secret; never sent to the
  // browser.
  TAVILY_API_KEY: string;
  // FRED (St. Louis Fed) API key (secret) for /api/econ_calendar — optional:
  // with it set, the calendar uses FRED releases/dates for the full macro
  // schedule (FOMC, CPI, PCE, jobs, …); without it, the endpoint falls back to
  // the Federal Reserve's keyless calendar JSON (FOMC + Beige Book only).
  FRED_API_KEY?: string;
  // OpenRouter site key (secret) used only by the server-side Copilot loop.
  // It is never returned to or accepted from the browser.
  OPEN_ROUTER_KEY: string;
  // One funded model and per-turn guardrails. These are non-secret Worker vars.
  COPILOT_MODEL: string;
  COPILOT_REASONING_EFFORT: string;
  COPILOT_MAX_OUTPUT_TOKENS?: string;
  COPILOT_MAX_HISTORY_CHARS?: string;
  // Non-secret base URL of the continuous CBOE loader worker, used by the
  // read-only /loader/* pass-through endpoints. Set as a `var` (not a secret).
  LOADER_BASE_URL?: string;
  // Admin bearer token (secret) for GET /api/admin/chat_history — the only
  // public read path for options.chat_history. The table is excluded from
  // /api/tables and blocked in /api/query for everyone without this token.
  ADMIN_TOKEN?: string;
  // Pipeline stream ingest URL for Copilot chat history (secret; the URL
  // subdomain is the credential). POST /api/chat/history publishes one
  // normalized record per chat turn to cboe_chat_history_v2 →
  // options.chat_history. Same "URL is the credential" model as the loader's
  // PIPELINE_*_URL secrets.
  PIPELINE_CHAT_HISTORY_URL?: string;
  // Pipelines → Send scoped API token (secret, same value as the loader's
  // PIPELINE_AUTH_TOKEN) authorizing stream ingest POSTs — the streams reject
  // unrelated tokens with 401 code 1014.
  PIPELINE_AUTH_TOKEN?: string;
  // D1 cache for the computed lake-schema payload (/api/tables). See
  // worker/migrations/0001_schema_cache.sql and `schemaTables` below.
  SCHEMA_DB: D1Database;
}

// ---------------------------------------------------------------------------
// Liquidity filter thresholds (mirror the original Python server)
// ---------------------------------------------------------------------------
const LIQ_MIN_VOLUME = 10;
const LIQ_MIN_OI = 100;
const LIQ_MAX_SPREAD = 0.15;
const LIQ_ATM_BAND = 0.1;
const LIQ_MIN_ATM_CONTRACTS = 5;

// Latest snapshot per symbol: the lake is append-only (multiple loader runs
// accumulate). Pick each symbol's newest underlying run from the decoupled
// options.underlying_snapshots table (security master facts live in
// options.securities; the worker reads the denormalized name/sector here). The
// `ticker` column plays the role `symbol` had in the retired underlyings table,
// so it is aliased to keep every downstream query byte-identical.
const LATEST_UNDERLYING =
  "SELECT ticker AS symbol, name, sector, spot_price, run_id, fetched_at " +
  "FROM options.underlying_snapshots " +
  "QUALIFY ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY fetched_at DESC) = 1";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
// TTL tiers: the lake is refreshed at most nightly (loader runs), so staleness
// is bounded by the loader cadence, not by these values. Endpoints quote
// different data at different rates:
//   RESULT_TTL_MS — screener endpoints (stats, screen, underlyings…)
//   LIQ_TTL_MS    — the liquid-underlyings set (recomputed from nightly data)
//   QUERY_TTL_MS  — /api/query (arbitrary SQL) + symbol detail chains: the
//                   heaviest lake compute; a 60-min memo bounds cross-user
//                   repeat cost. The in-isolate Map dies with the isolate
//                   (redeploy/eviction), so this is a bound, not a leak.
//   REF_TTL_MS    — near-static reference rows (symbol/name/sector for the
//                   typeahead); refreshed effectively only when names/constituents change.
const RESULT_TTL_MS = 30 * 60 * 1000;
const LIQ_TTL_MS = 60 * 60 * 1000;
const QUERY_TTL_MS = 60 * 60 * 1000;
const REF_TTL_MS = 12 * 60 * 60 * 1000;
const R2SQL_LIMIT_MAX = 10000;

interface CacheEntry { ts: number; val: unknown; }
const cache = new Map<string, CacheEntry>();

function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) return Promise.resolve(hit.val as T);
  return compute().then((val) => { cache.set(key, { ts: now, val }); return val; });
}

/** FNV-1a 32-bit hex — deterministic memo key for arbitrary SQL strings. */
function sqlHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// R2 SQL REST client
// ---------------------------------------------------------------------------
function apiUrl(env: Env): string {
  return `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.R2_SQL_ACCOUNT_ID}/r2-sql/query/${env.R2_SQL_BUCKET}`;
}

interface R2Row { [k: string]: unknown; }

async function r2sql(env: Env, sql: string, key?: string, ttlMs: number = RESULT_TTL_MS): Promise<R2Row[]> {
  const run = () => fetch(apiUrl(env), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.R2_SQL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`R2 SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const b = await r.json() as { success: boolean; result?: { rows: R2Row[] }; errors?: { message: string }[] };
    if (!b.success) {
      const msg = b.errors?.[0]?.message ?? "unknown R2 SQL error";
      throw new Error(`R2 SQL: ${msg}`);
    }
    return b.result?.rows ?? [];
  });
  return key ? cached<R2Row[]>(key, ttlMs, run) : run();
}

// ---------------------------------------------------------------------------
// SQL literal helpers (R2 SQL REST has no parameter binding)
// ---------------------------------------------------------------------------
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  // string: double single quotes
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function inList(syms: string[]): string {
  if (!syms.length) return "(NULL)";
  return "(" + syms.map((s) => lit(s)).join(",") + ")";
}

// ---------------------------------------------------------------------------
// Liquid underlying symbols (cached, shared across endpoints)
// ---------------------------------------------------------------------------
async function liquidSymbols(env: Env): Promise<string[]> {
  return cached<string[]>("__liq__", LIQ_TTL_MS, async () => {
    const sql =
      "SELECT c.symbol AS symbol FROM options.option_contracts c " +
      "JOIN (" + LATEST_UNDERLYING + ") u ON u.symbol = c.symbol " +
      "WHERE u.spot_price > 0 AND c.bid > 0 AND c.ask > 0 AND c.ask >= c.bid " +
      "AND (c.ask - c.bid) / ((c.bid + c.ask) / 2.0) <= " + lit(LIQ_MAX_SPREAD) + " " +
      "AND (COALESCE(c.volume, 0) >= " + lit(LIQ_MIN_VOLUME) + " OR COALESCE(c.open_interest, 0) >= " + lit(LIQ_MIN_OI) + ") " +
      "AND ABS((c.strike - u.spot_price) / u.spot_price) <= " + lit(LIQ_ATM_BAND) + " " +
      "GROUP BY c.symbol HAVING COUNT(*) >= " + lit(LIQ_MIN_ATM_CONTRACTS) + " " +
      "ORDER BY c.symbol";
    const rows = await r2sql(env, sql);
    return rows.map((r) => String(r.symbol)).sort();
  });
}

// ---------------------------------------------------------------------------
// Endpoint handlers — return shapes match frontend/src/api.ts interfaces exactly
// ---------------------------------------------------------------------------
async function stats(env: Env, liquidOnly: boolean): Promise<{
  underlyings: number; contracts: number; calls: number; puts: number; last_updated: string;
}> {
  if (liquidOnly) {
    const syms = await liquidSymbols(env);
    const il = inList(syms);
    const [cc, cp, pp, last] = await Promise.all([
      r2sql(env, `SELECT COUNT(*) n FROM options.option_contracts WHERE symbol IN ${il}`, "stats_c_liq"),
      r2sql(env, `SELECT COUNT(*) n FROM options.option_contracts WHERE type='call' AND symbol IN ${il}`, "stats_call_liq"),
      r2sql(env, `SELECT COUNT(*) n FROM options.option_contracts WHERE type='put' AND symbol IN ${il}`, "stats_put_liq"),
      r2sql(env, `SELECT COALESCE(MAX(fetched_at), '') AS last FROM options.option_contracts WHERE symbol IN ${il} AND fetched_at LIKE '2%'`, "stats_last_liq"),
    ]);
    return {
      underlyings: syms.length,
      contracts: num(cc[0]?.n), calls: num(cp[0]?.n), puts: num(pp[0]?.n),
      last_updated: String(last[0]?.last ?? ""),
    };
  }
  const [u, c, calls] = await Promise.all([
    r2sql(env, `SELECT COUNT(*) n FROM (${LATEST_UNDERLYING}) u`, "stats_u"),
    r2sql(env, `SELECT COUNT(*) n FROM options.option_contracts`, "stats_c"),
    r2sql(env, `SELECT type, COUNT(*) n FROM options.option_contracts GROUP BY type`, "stats_type"),
  ]);
  let nc = 0, np = 0;
  for (const r of calls) { if (r.type === "call") nc = num(r.n); else np = num(r.n); }
  const last = await r2sql(env, `SELECT COALESCE(MAX(fetched_at), '') AS last FROM options.option_contracts WHERE fetched_at LIKE '2%'`, "stats_last");
  return {
    underlyings: num(u[0]?.n), contracts: num(c[0]?.n), calls: nc, puts: np,
    last_updated: String(last[0]?.last ?? ""),
  };
}

// Recent loader refresh runs (the consumer view of options.refresh_runs).
async function runs(env: Env, limit = 5): Promise<{
  run_id: string; started_at: string; completed_at: string | null; as_of_date: string;
  expected_symbols: number; successful_symbols: number; failed_symbols: number;
  contract_count: number; status: string; error_summary: string | null;
}[]> {
  const lim = clamp(limit, 1, 50);
  const rows = await r2sql(env,
    `SELECT run_id, started_at, completed_at, as_of_date, expected_symbols, ` +
    `successful_symbols, failed_symbols, contract_count, status, error_summary ` +
    `FROM options.refresh_runs ORDER BY started_at DESC LIMIT ${lim}`, "runs_" + lim);
  return rows.map((r) => ({
    run_id: String(r.run_id ?? ""),
    started_at: String(r.started_at ?? ""),
    completed_at: strOrNull(r.completed_at),
    as_of_date: String(r.as_of_date ?? ""),
    expected_symbols: num(r.expected_symbols),
    successful_symbols: num(r.successful_symbols),
    failed_symbols: num(r.failed_symbols),
    contract_count: num(r.contract_count),
    status: String(r.status ?? ""),
    error_summary: strOrNull(r.error_summary),
  }));
}

async function liquidity(env: Env): Promise<{
  enabled_defaults: typeof LIQ_DEFAULTS; total_underlyings: number; liquid_underlyings: number; description: string;
}> {
  const [syms, u] = await Promise.all([
    liquidSymbols(env),
    r2sql(env, `SELECT COUNT(*) n FROM (${LATEST_UNDERLYING})`, "liq_total"),
  ]);
  return {
    enabled_defaults: LIQ_DEFAULTS,
    total_underlyings: num(u[0]?.n),
    liquid_underlyings: syms.length,
    description: LIQ_DESC,
  };
}
const LIQ_DEFAULTS = {
  min_volume: LIQ_MIN_VOLUME, min_open_interest: LIQ_MIN_OI, max_spread: LIQ_MAX_SPREAD,
  atm_band: LIQ_ATM_BAND, min_atm_contracts: LIQ_MIN_ATM_CONTRACTS,
};
const LIQ_DESC =
  `An underlying is tradable iff it has >= ${LIQ_MIN_ATM_CONTRACTS} contracts within +/-` +
  `${Math.round(LIQ_ATM_BAND * 100)}% of spot that each have a two-sided quote (bid>0, ask>=bid), ` +
  `a relative bid-ask spread <= ${Math.round(LIQ_MAX_SPREAD * 100)}%, and demonstrated interest ` +
  `(volume >= ${LIQ_MIN_VOLUME} OR open interest >= ${LIQ_MIN_OI}).`;

async function sectors(env: Env, liquidOnly: boolean): Promise<{ sector: string; symbols: number; avg_spot: number | null }[]> {
  let filter = "";
  if (liquidOnly) {
    const syms = await liquidSymbols(env);
    filter = `WHERE u.symbol IN ${inList(syms)}`;
  }
  const rows = await r2sql(env,
    `SELECT sector, COUNT(*) AS symbols, AVG(spot_price) AS avg_spot ` +
    `FROM (${LATEST_UNDERLYING}) u ${filter} GROUP BY sector ORDER BY sector`,
    "sectors_" + liquidOnly);
  return rows.map((r) => ({ sector: String(r.sector), symbols: num(r.symbols), avg_spot: numOrNull(r.avg_spot) }));
}

async function underlyings(env: Env, p: {
  sector?: string; q?: string; liquid_only?: boolean; limit?: number; offset?: number;
}): Promise<{ total: number; items: { symbol: string; name: string | null; sector: string | null; spot: number | null; contracts: number }[] }> {
  const where: string[] = [];
  if (p.liquid_only) { const syms = await liquidSymbols(env); where.push(`u.symbol IN ${inList(syms)}`); }
  if (p.sector) where.push(`u.sector = ${lit(p.sector)}`);
  if (p.q) { const s = `%${p.q.toUpperCase()}%`; where.push(`(UPPER(u.symbol) LIKE ${lit(s)} OR UPPER(COALESCE(u.name,'')) LIKE ${lit(s)})`); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";
  // latest underlying (≤502 rows) + per-symbol contract count. Fetch all, page in-memory.
  const key = "und:" + clause;
  const all = await cached<{ symbol: string; name: string | null; sector: string | null; spot: number | null; contracts: number }[]>(key, RESULT_TTL_MS, async () => {
    const rows = await r2sql(env,
      `SELECT u.symbol, u.name, u.sector, u.spot_price AS spot, ` +
      `(SELECT COUNT(*) FROM options.option_contracts c WHERE c.symbol = u.symbol) AS contracts ` +
      `FROM (${LATEST_UNDERLYING}) u ${clause} ORDER BY u.symbol`);
    return rows.map((r) => ({
      symbol: String(r.symbol), name: strOrNull(r.name), sector: strOrNull(r.sector),
      spot: numOrNull(r.spot), contracts: num(r.contracts),
    }));
  });
  const limit = clamp(p.limit ?? 50, 1, 1000);
  const offset = clamp(p.offset ?? 0, 0, 100000);
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

type Row = Record<string, unknown>;

const SORT_WHITELIST = new Set(["volume", "open_interest", "strike", "implied_vol", "delta", "gamma", "theta", "vega", "bid", "ask", "last", "expiration"]);

async function screen(env: Env, p: {
  symbol?: string; type?: string; sector?: string;
  min_strike?: number; max_strike?: number; min_volume?: number; min_open_interest?: number;
  min_iv?: number; max_iv?: number; min_delta?: number; max_delta?: number;
  in_the_money?: boolean; expiration_before?: string; expiration_after?: string;
  liquid_only?: boolean; near_spot_strikes?: number;
  sort?: string; order?: string; limit?: number; offset?: number;
}): Promise<{ total: number; items: Row[]; truncated?: boolean }> {
  const where: string[] = ["c.symbol IS NOT NULL"];
  if (p.symbol) where.push(`c.symbol = ${lit(p.symbol.toUpperCase())}`);
  if (p.type === "call" || p.type === "put") where.push(`c.type = ${lit(p.type)}`);
  if (p.sector) where.push(`u.sector = ${lit(p.sector)}`);
  if (p.min_strike != null) where.push(`c.strike >= ${lit(p.min_strike)}`);
  if (p.max_strike != null) where.push(`c.strike <= ${lit(p.max_strike)}`);
  if (p.min_volume != null) where.push(`COALESCE(c.volume,0) >= ${lit(p.min_volume)}`);
  if (p.min_open_interest != null) where.push(`COALESCE(c.open_interest,0) >= ${lit(p.min_open_interest)}`);
  if (p.min_iv != null) where.push(`c.implied_vol >= ${lit(p.min_iv)}`);
  if (p.max_iv != null) where.push(`c.implied_vol <= ${lit(p.max_iv)}`);
  if (p.min_delta != null) where.push(`c.delta >= ${lit(p.min_delta)}`);
  if (p.max_delta != null) where.push(`c.delta <= ${lit(p.max_delta)}`);
  if (p.in_the_money != null) where.push(`c.in_the_money = ${lit(p.in_the_money)}`);
  if (p.expiration_before) where.push(`c.expiration <= ${lit(p.expiration_before)}`);
  if (p.expiration_after) where.push(`c.expiration >= ${lit(p.expiration_after)}`);
  if (p.liquid_only) { const syms = await liquidSymbols(env); where.push(`c.symbol IN ${inList(syms)}`); }

  const sortCol = SORT_WHITELIST.has(p.sort ?? "") ? (p.sort as string) : "volume";
  const order = p.order === "asc" ? "ASC" : "DESC";
  const sortExpr = sortCol === "expiration"
    ? `c.${sortCol}`
    : `COALESCE(c.${sortCol},0)`;

  let cte = "";
  const nss = p.near_spot_strikes ?? 50;
  if (nss && nss > 0) {
    cte =
      "WITH atm_strikes AS (\n" +
      "  SELECT symbol, strike FROM (\n" +
      "    SELECT ds.symbol, ds.strike,\n" +
      "           ROW_NUMBER() OVER (PARTITION BY ds.symbol ORDER BY ABS(ds.strike - au.spot_price)) AS rn\n" +
      "    FROM (SELECT DISTINCT c2.symbol, c2.strike FROM options.option_contracts c2\n" +
      "          JOIN (" + LATEST_UNDERLYING + ") u2 ON u2.symbol = c2.symbol WHERE u2.spot_price IS NOT NULL) ds\n" +
      "    JOIN (" + LATEST_UNDERLYING + ") au ON au.symbol = ds.symbol\n" +
      "  ) WHERE rn <= " + lit(nss) + "\n)\n";
    where.push("EXISTS (SELECT 1 FROM atm_strikes a WHERE a.symbol = c.symbol AND a.strike = c.strike)");
  }

  const clause = "WHERE " + where.join(" AND ");
  const key = "screen:" + cte + "|" + clause + "|" + sortExpr + "|" + order;

  // Fetch the ordered result set (capped at R2 SQL's 10000-row LIMIT) once, page in-memory.
  const fetched = await cached<{ rows: Row[]; total: number; truncated: boolean }>(key, RESULT_TTL_MS, async () => {
    const [rows, totalRows] = await Promise.all([
      r2sql(env,
        cte +
        "SELECT c.symbol, u.name AS name, u.sector AS sector, u.spot_price AS spot, " +
        "c.expiration, c.type, c.strike, c.last, c.bid, c.ask, " +
        "c.volume, c.open_interest, c.implied_vol, " +
        "c.delta, c.gamma, c.theta, c.vega, c.rho, c.in_the_money, " +
        "c.theo, c.bid_size, c.ask_size, " +
        "CASE WHEN u.spot_price IS NOT NULL AND c.strike > 0 " +
        "THEN ROUND((c.strike - u.spot_price)/u.spot_price*100, 2) END AS moneyness_pct " +
        "FROM options.option_contracts c " +
        "JOIN (" + LATEST_UNDERLYING + ") u ON u.symbol = c.symbol " +
        clause + " " +
        "ORDER BY " + sortExpr + " " + order + ", c.symbol ASC " +
        "LIMIT " + R2SQL_LIMIT_MAX),
      r2sql(env, cte + "SELECT COUNT(*) AS n FROM options.option_contracts c JOIN (" + LATEST_UNDERLYING + ") u ON u.symbol = c.symbol " + clause),
    ]);
    const total = num(totalRows[0]?.n);
    return { rows: rows as Row[], total, truncated: total > R2SQL_LIMIT_MAX };
  });

  const limit = clamp(p.limit ?? 100, 1, 1000);
  const offset = clamp(p.offset ?? 0, 0, 100000);
  const items = fetched.rows.slice(offset, offset + limit);
  return { total: fetched.total, items, truncated: fetched.truncated && (offset + limit) >= R2SQL_LIMIT_MAX };
}

async function symbols(env: Env, q?: string, liquidOnly?: boolean, limit = 50): Promise<{ symbol: string; name: string | null; sector: string | null }[]> {
  let filter = "";
  if (liquidOnly) { const syms = await liquidSymbols(env); filter = `AND symbol IN ${inList(syms)}`; }
  const lim = clamp(limit, 1, 1000);
  const liqTag = liquidOnly ? "L" : "A";
  if (!q) {
    // Full universe pull (limit 1000 covers all ~500 symbols) — the reference
    // tier: the browser caches this across sessions and filters client-side.
    const rows = await r2sql(env,
      `SELECT symbol, name, sector FROM (${LATEST_UNDERLYING}) WHERE true ${filter} ORDER BY symbol LIMIT ${lim}`,
      "syms_all_" + liqTag + "_" + lim, REF_TTL_MS);
    return rows.map(row);
  }
  const u = `%${q.toUpperCase()}%`;
  const rows = await r2sql(env,
    `SELECT symbol, name, sector FROM (${LATEST_UNDERLYING}) ` +
    `WHERE (UPPER(symbol) LIKE ${lit(u)} OR UPPER(COALESCE(name,'')) LIKE ${lit(u)}) ${filter} ` +
    `ORDER BY CASE WHEN UPPER(symbol) = ${lit(q.toUpperCase())} THEN 0 WHEN UPPER(symbol) LIKE ${lit(q.toUpperCase() + "%")} THEN 1 ELSE 2 END, symbol LIMIT ${lim}`,
    "syms_q_" + liqTag + "_" + q.toUpperCase() + "_" + lim, REF_TTL_MS);
  return rows.map(row);
}
function row(r: R2Row): { symbol: string; name: string | null; sector: string | null } {
  return { symbol: String(r.symbol), name: strOrNull(r.name), sector: strOrNull(r.sector) };
}

// ---------------------------------------------------------------------------
// Symbol detail enrichment: daily OHLC bars, realized vol, corporate actions.
// These tables (options.ohlc / options.realized_vol / options.corporate_actions)
// are newer than the chain data, so each query is isolated and degrades to
// empty on failure (missing table, empty lake, transient R2 SQL error) — the
// endpoint must keep serving contracts even when enrichment is unavailable.
// OHLC is append-only across daily runs, so rows are deduped per (symbol,date)
// keeping the newest run; bars come back newest-first and are flipped to
// ascending for the chart.
// ---------------------------------------------------------------------------
const OHLC_BARS_LIMIT = 260; // ~1y of trading days → 52w high/low + sparkline

function enrichQuery(env: Env, symbol: string, kind: string, sql: string, key: string) {
  return r2sql(env, sql, key).catch((e) => {
    console.error(`symbol ${symbol} ${kind} enrichment failed`, e);
    return [];
  });
}

async function enrichSymbol(env: Env, symbol: string): Promise<{
  ohlc: Row[]; realized_vol: Row | null; corporate_actions: Row[];
}> {
  const sym = lit(symbol);
  const [ohlcRows, rvRows, caRows] = await Promise.all([
    enrichQuery(env, symbol, "ohlc",
      `SELECT date, open, high, low, close, volume FROM (` +
      `  SELECT date, open, high, low, close, volume,` +
      `    ROW_NUMBER() OVER (PARTITION BY date ORDER BY fetched_at DESC, run_id DESC) rn` +
      `  FROM options.ohlc WHERE symbol = ${sym}` +
      `) WHERE rn = 1 ORDER BY date DESC LIMIT ${OHLC_BARS_LIMIT}`,
      `sym_ohlc_${symbol}`),
    enrichQuery(env, symbol, "realized_vol",
      `SELECT as_of_date, realized_vol_30d, realized_vol_90d, n_returns_30, n_returns_90 FROM (` +
      `  SELECT as_of_date, realized_vol_30d, realized_vol_90d, n_returns_30, n_returns_90,` +
      `    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY fetched_at DESC, run_id DESC) rn` +
      `  FROM options.realized_vol WHERE symbol = ${sym}` +
      `) WHERE rn = 1`,
      `sym_rv_${symbol}`),
    enrichQuery(env, symbol, "corporate_actions",
      `SELECT action_type, ex_date, numerator, denominator, amount FROM (` +
      `  SELECT action_type, ex_date, numerator, denominator, amount,` +
      `    ROW_NUMBER() OVER (PARTITION BY action_type, ex_date ORDER BY fetched_at DESC, run_id DESC) rn` +
      `  FROM options.corporate_actions WHERE ticker = ${sym}` +
      `) WHERE rn = 1 ORDER BY ex_date DESC LIMIT 8`,
      `sym_ca_${symbol}`),
  ]);
  return {
    ohlc: (ohlcRows as Row[]).map((r) => ({
      date: String(r.date),
      open: numOrNull(r.open), high: numOrNull(r.high), low: numOrNull(r.low),
      close: numOrNull(r.close), volume: numOrNull(r.volume),
    })).reverse(),
    realized_vol: rvRows.length ? {
      as_of_date: String(rvRows[0].as_of_date),
      realized_vol_30d: numOrNull(rvRows[0].realized_vol_30d),
      realized_vol_90d: numOrNull(rvRows[0].realized_vol_90d),
      n_returns_30: numOrNull(rvRows[0].n_returns_30),
      n_returns_90: numOrNull(rvRows[0].n_returns_90),
    } : null,
    corporate_actions: (caRows as Row[]).map((r) => ({
      action_type: String(r.action_type),
      ex_date: String(r.ex_date),
      numerator: numOrNull(r.numerator),
      denominator: numOrNull(r.denominator),
      amount: numOrNull(r.amount),
    })),
  };
}

async function symbolDetail(env: Env, symbol: string): Promise<{
  underlying: { symbol: string; name: string | null; sector: string | null; spot: number | null; fetched_at: string | null } | null;
  contracts: Row[]; expirations: string[]; n_contracts: number; liquid: boolean;
  ohlc: Row[]; realized_vol: Row | null; corporate_actions: Row[];
}> {
  const u = await r2sql(env, `SELECT symbol, name, sector, spot_price, run_id, fetched_at FROM (${LATEST_UNDERLYING}) WHERE symbol = ${lit(symbol)}`, "symu_" + symbol, QUERY_TTL_MS);
  if (!u.length) {
    return { underlying: null, contracts: [], expirations: [], n_contracts: 0, liquid: false, ohlc: [], realized_vol: null, corporate_actions: [] };
  }
  const ud = u[0];
  // contracts for the latest run of this symbol + enrichment, in parallel.
  // The chain key embeds run_id, so a new loader run naturally invalidates it.
  const [{ rows, expirations }, enrich, syms] = await Promise.all([
    r2sql(env,
      `SELECT expiration, type, strike, last, bid, ask, volume, open_interest, implied_vol, ` +
      `delta, gamma, theta, vega, rho, in_the_money, theo, bid_size, ask_size, fetched_at ` +
      `FROM options.option_contracts WHERE symbol = ${lit(symbol)} ` +
      `AND run_id = ${lit(ud.run_id)} ORDER BY expiration, strike, type LIMIT ${R2SQL_LIMIT_MAX}`,
      "symc_" + symbol + "_" + ud.run_id, QUERY_TTL_MS)
      .then((r) => ({ rows: r, expirations: sortedUnique(r.map((x) => String(x.expiration))) })),
    enrichSymbol(env, symbol),
    liquidSymbols(env),
  ]);
  return {
    underlying: {
      symbol: String(ud.symbol), name: strOrNull(ud.name), sector: strOrNull(ud.sector),
      spot: numOrNull(ud.spot_price), fetched_at: strOrNull(ud.fetched_at),
    },
    contracts: rows as Row[],
    expirations,
    n_contracts: rows.length,
    liquid: syms.includes(symbol),
    ohlc: enrich.ohlc,
    realized_vol: enrich.realized_vol,
    corporate_actions: enrich.corporate_actions,
  };
}

// ---------------------------------------------------------------------------
// Lake schema (/api/tables) — D1-backed cache, serve-stale + background refresh
// ---------------------------------------------------------------------------
// The schema payload is expensive to compute: SHOW TABLES, then per table
// DESCRIBE + COUNT(*) + a 3-row sample — several R2 SQL round trips against
// the lake (~8s). The AI copilot loads it on every chat question and the SQL
// Lab sidebar on every mount, so users must NEVER block on that compute: fresh
// rows serve immediately, stale rows serve the cached payload instantly while
// a background refresh (ctx.waitUntil) recomputes, and a throttled background
// probe diffs the lake's table/column shape against the cache so loader schema
// changes refresh proactively instead of waiting for the next TTL expiry. Only
// an explicit ?force=1 (SQL Lab refresh) or a truly empty cache (first-ever
// call on a fresh D1) computes synchronously. D1 failures degrade to live
// compute (the R2 SQL lake remains the source of truth — the cache is a
// performance layer only).
const SCHEMA_TTL_MS = 10 * 60 * 1000; // schema structure is near-static
const SCHEMA_CACHE_KEY = "lake_tables";
const SCHEMA_SAMPLE_LIMIT = 3;
// Background change-detection cadence: on fresh reads, diff the lake's shape
// against the cached payload at most once per interval, per isolate.
const SCHEMA_PROBE_INTERVAL_MS = 60 * 1000;

interface LakeTable {
  name: string;
  row_count: number | null;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}

// Lake tables that must NEVER surface to users: options.chat_history holds
// full Copilot transcripts (admin-only by design). Excluded here from the
// /api/tables payload AND from the background change-probe's name diff (both
// sides must compare the same filtered set or the probe would see a permanent
// mismatch and churn a refresh every interval). /api/query separately blocks
// references to these tables unless the request carries ADMIN_TOKEN.
const PRIVATE_LAKE_TABLES = new Set(["chat_history"]);
const PRIVATE_LAKE_TABLES_RE = /\bchat_history\b/;
const isPublicLakeTable = (name: string): boolean => !PRIVATE_LAKE_TABLES.has(name);

/** Compute the full schema payload straight from the lake (uncached). */
async function loadLakeTables(env: Env): Promise<LakeTable[]> {
  const list = await r2sql(env, "SHOW TABLES IN options");
  return Promise.all(
    list
      .map((t) => String(t.table_name))
      .filter(isPublicLakeTable)
      .map(async (name): Promise<LakeTable> => {
        const [cols, cnt, sample] = await Promise.all([
          r2sql(env, `DESCRIBE options.${name}`),
          r2sql(env, `SELECT COUNT(*) n FROM options.${name}`, "tbl_count_" + name),
          r2sql(env, `SELECT * FROM options."${name}" LIMIT ${SCHEMA_SAMPLE_LIMIT}`, "tbl_sample_" + name),
        ]);
        return {
          name,
          row_count: num(cnt[0]?.n),
          columns: cols.map((c) => ({ name: String(c.column_name), type: String(c.type) })),
          sample: sample as Record<string, unknown>[],
        };
      }),
  );
}

/** Read the cached payload row; null when missing or D1 read fails. */
async function readSchemaRow(env: Env): Promise<{ payload: string; expires_at: number } | null> {
  try {
    return (await env.SCHEMA_DB.prepare(
      "SELECT payload, expires_at FROM schema_cache WHERE key = ?1",
    ).bind(SCHEMA_CACHE_KEY).first<{ payload: string; expires_at: number }>()) ?? null;
  } catch (e) {
    // D1 read failed — the caller falls back to live compute; the lake is
    // authoritative, the cache is a performance layer only.
    console.error("schema cache read failed", e);
    return null;
  }
}

async function writeSchemaRow(env: Env, tables: LakeTable[]): Promise<void> {
  try {
    await env.SCHEMA_DB.prepare(
      "INSERT INTO schema_cache (key, payload, expires_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at",
    ).bind(SCHEMA_CACHE_KEY, JSON.stringify(tables), Date.now() + SCHEMA_TTL_MS).run();
  } catch (e) {
    // D1 write failed — serve the freshly computed payload anyway.
    console.error("schema cache write failed", e);
  }
}

// Single-flight guard: at most one background refresh per isolate.
let schemaRefreshRunning = false;
let lastSchemaProbeAt = 0;

/** Recompute the payload from the lake and upsert into D1 (background-safe). */
async function refreshLakeSchema(env: Env): Promise<void> {
  if (schemaRefreshRunning) return;
  schemaRefreshRunning = true;
  try {
    await writeSchemaRow(env, await loadLakeTables(env));
  } catch (e) {
    // Lake/D1 hiccup — leave the (stale) row in place; the next read that
    // finds it stale retries the refresh. Never surfaced to the user.
    console.error("background schema refresh failed", e);
  } finally {
    schemaRefreshRunning = false;
  }
}

/** Fingerprint of the cached payload: sorted "table:column" pairs. */
function schemaFingerprint(tables: LakeTable[]): string {
  const pairs: string[] = [];
  for (const t of tables) for (const c of t.columns) pairs.push(`${t.name}:${c.name}`);
  return pairs.sort().join("|");
}

/** Background diff of the lake's current shape vs the cached payload. */
async function probeLakeSchema(env: Env, payload: string): Promise<void> {
  const cached = JSON.parse(payload) as LakeTable[];
  let listed: { table_name?: unknown }[];
  try {
    listed = await r2sql(env, "SHOW TABLES IN options");
  } catch (e) {
    console.error("schema change probe failed", e);
    return;
  }
  const tableNames = listed
    .map((t) => String(t.table_name))
    .filter(isPublicLakeTable)
    .sort();
  const cachedNames = cached.map((t) => t.name).sort();
  if (tableNames.join("|") !== cachedNames.join("|")) {
    // Table added/removed — skip the column pass, refresh now.
    console.log("lake schema changed (tables) — refreshing schema cache in background");
    await refreshLakeSchema(env);
    return;
  }
  // Table set matches — diff columns via one DESCRIBE per table. The lake has
  // a handful of `options.*` tables, so this is a few cheap metadata calls.
  try {
    const shaped = await Promise.all(
      tableNames.map(async (name) => ({
        name,
        cols: (await r2sql(env, `DESCRIBE options.${name}`)) as { column_name?: unknown }[],
      })),
    );
    const current = shaped
      .flatMap((t) => t.cols.map((c) => `${t.name}:${String(c.column_name)}`))
      .sort()
      .join("|");
    if (current !== schemaFingerprint(cached)) {
      console.log("lake schema changed (columns) — refreshing schema cache in background");
      await refreshLakeSchema(env);
    }
  } catch (e) {
    console.error("schema column probe failed", e);
  }
}

/** Throttled probe kick-off from the fresh-read path (never blocks the request). */
function maybeProbeSchema(ctx: ExecutionContext, env: Env, payload: string): void {
  const now = Date.now();
  if (now - lastSchemaProbeAt < SCHEMA_PROBE_INTERVAL_MS) return;
  lastSchemaProbeAt = now;
  ctx.waitUntil(probeLakeSchema(env, payload));
}

/**
 * Schema payload served by /api/tables — users never wait on the ~8s lake
 * recompute. Fresh rows serve immediately (plus a throttled background
 * change-detection probe); stale rows serve the cached payload instantly while
 * the refresh runs in the background via ctx.waitUntil; only a truly empty
 * cache (first-ever call on a fresh D1) or an explicit ?force=1 (SQL Lab
 * refresh) computes synchronously. Trade-off: after a TTL expiry a reader sees
 * the previous payload for at most one refresh cycle (~10s) instead of an 8s
 * stall, and background refreshes also fire when the lake's shape changes.
 */
async function schemaTables(env: Env, ctx: ExecutionContext, force: boolean): Promise<LakeTable[]> {
  const row = await readSchemaRow(env);
  if (force) {
    // Explicit user intent (SQL Lab refresh): recompute now, serve fresh.
    const tables = await loadLakeTables(env);
    await writeSchemaRow(env, tables);
    return tables;
  }
  if (row) {
    if (Date.now() < row.expires_at) {
      maybeProbeSchema(ctx, env, row.payload);
      return JSON.parse(row.payload) as LakeTable[];
    }
    // Stale — serve the cached payload now, refresh in the background.
    ctx.waitUntil(refreshLakeSchema(env));
    return JSON.parse(row.payload) as LakeTable[];
  }
  // Nothing cached yet: compute once synchronously so there is a row for every
  // future read. One-time cost per environment (prod's cache is already warm).
  const tables = await loadLakeTables(env);
  await writeSchemaRow(env, tables);
  return tables;
}

async function runQuery(env: Env, sqlIn: string, limit = 1000): Promise<{ columns: string[]; rows: Row[]; row_count: number; truncated: boolean; limit: number; error?: string }> {
  const cleaned = sqlIn.trim().replace(/;$/, "").trim();
  if (!cleaned) return { columns: [], rows: [], row_count: 0, truncated: false, limit, error: "Empty query" };
  const head = cleaned.replace(/^\(/, "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (!["SELECT", "WITH", "DESCRIBE", "DESC", "SHOW", "EXPLAIN"].includes(head))
    return { columns: [], rows: [], row_count: 0, truncated: false, limit, error: "Only read-only queries allowed" };
  const lower = cleaned.toLowerCase();
  for (const kw of ["insert into", "update ", "delete from", "drop ", "create ", "alter ", "truncate ", "attach ", "detach "])
    if (lower.includes(kw)) return { columns: [], rows: [], row_count: 0, truncated: false, limit, error: "Disallowed keyword" };
  // Cartesian products of large tables are the one expensive pattern R2 SQL does
  // NOT budget-gate up front (it may just time out). Reject them outright: options
  // analytics never needs a CROSS JOIN. R2 SQL's other cost guards (read-only,
  // LIMIT default 500, budget-gated DISTINCT/aggregate/window) already apply.
  if (/\bcross\s+join\b/.test(lower))
    return { columns: [], rows: [], row_count: 0, truncated: false, limit, error: "CROSS JOIN is not allowed (cartesian products of large tables). Join on a key with WHERE filters instead." };
  const lim = clamp(limit, 1, R2SQL_LIMIT_MAX);
  try {
    // Memoize by full outer SQL: identical queries (the chat frame pulls, SQL
    // Lab reruns) hit the isolate cache instead of the lake. QUERY_TTL_MS is a
    // bound, not a leak — the Map dies with the isolate and data refreshes nightly.
    const outer = `SELECT * FROM (${cleaned}) AS __q LIMIT ${lim}`;
    const rows = await r2sql(env, outer, "q_" + sqlHash(outer), QUERY_TTL_MS);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, row_count: rows.length, truncated: rows.length >= lim, limit: lim };
  } catch (e) {
    return { columns: [], rows: [], row_count: 0, truncated: false, limit: lim, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Notebook: 45-day premium leaders
// ---------------------------------------------------------------------------
async function notebookPremium(env: Env, p: {
  target_dte?: number; tolerance?: number; moneyness_band?: number; min_volume?: number; liquid_only?: boolean; limit?: number;
}): Promise<{ notebook: string; target_dte: number; tolerance: number; moneyness_band: number; min_volume: number; calls: Row[]; puts: Row[] }> {
  const targetDte = p.target_dte ?? 45;
  const tol = p.tolerance ?? 7;
  const band = p.moneyness_band ?? 0.15;
  const minVol = p.min_volume ?? 0;
  const limit = clamp(p.limit ?? 25, 1, 200);
  let liqClause = "";
  if (p.liquid_only) { const syms = await liquidSymbols(env); liqClause = `AND c.symbol IN ${inList(syms)}`; }
  const lo = Math.max(targetDte - tol, 0);
  const hi = targetDte + tol;
  const sql =
    "WITH exp AS (\n" +
    "  SELECT symbol, expiration, (CAST(expiration AS DATE) - CURRENT_DATE) AS dte,\n" +
    "         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ABS((CAST(expiration AS DATE) - CURRENT_DATE) - " + lit(targetDte) + ")) AS rn\n" +
    "  FROM (SELECT DISTINCT symbol, expiration FROM options.option_contracts) e\n" +
    "  WHERE (CAST(expiration AS DATE) - CURRENT_DATE) BETWEEN " + lit(lo) + " AND " + lit(hi) + "\n" +
    "),\n" +
    "ranked AS (\n" +
    "  SELECT c.symbol, u.name, u.sector, u.spot_price AS spot, c.expiration, c.type, c.strike,\n" +
    "         c.last, c.bid, c.ask, c.volume, c.open_interest, c.implied_vol, c.delta, c.in_the_money,\n" +
    "         COALESCE(c.last, (c.bid + c.ask) / 2.0) AS premium,\n" +
    "         CASE WHEN u.spot_price IS NOT NULL AND u.spot_price > 0 THEN (c.strike - u.spot_price) / u.spot_price END AS moneyness,\n" +
    "         CASE WHEN u.spot_price IS NOT NULL AND u.spot_price > 0 THEN COALESCE(c.last, (c.bid + c.ask) / 2.0) / u.spot_price END AS premium_ratio,\n" +
    "         ROW_NUMBER() OVER (PARTITION BY c.symbol, c.type ORDER BY " +
    "           (CASE WHEN u.spot_price IS NOT NULL AND u.spot_price > 0 THEN COALESCE(c.last, (c.bid + c.ask) / 2.0) / u.spot_price END) DESC NULLS LAST, " +
    "           COALESCE(c.volume,0) DESC) AS prn\n" +
    "  FROM options.option_contracts c JOIN exp e ON e.symbol = c.symbol AND e.expiration = c.expiration\n" +
    "  JOIN (" + LATEST_UNDERLYING + ") u ON u.symbol = c.symbol\n" +
    "  WHERE e.rn = 1 AND u.spot_price IS NOT NULL AND u.spot_price > 0\n" +
    "    AND COALESCE(c.last, (c.bid + c.ask) / 2.0) IS NOT NULL\n" +
    "    AND COALESCE(c.last, (c.bid + c.ask) / 2.0) > 0\n" +
    "    AND COALESCE(c.volume, 0) >= " + lit(minVol) + "\n" +
    "    AND ABS((c.strike - u.spot_price) / u.spot_price) <= " + lit(band) + "\n" +
    "    " + liqClause + "\n" +
    "),\n" +
    "calls_ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY type ORDER BY premium_ratio DESC NULLS LAST) AS trn FROM ranked WHERE prn = 1)\n" +
    "SELECT symbol, name, sector, spot, expiration, type, strike, last, bid, ask, volume, open_interest, implied_vol, delta, in_the_money, premium, moneyness, premium_ratio\n" +
    "FROM calls_ranked WHERE trn <= " + lit(limit) + " ORDER BY type, premium_ratio DESC NULLS LAST";
  const rows = (await r2sql(env, sql,
    "nb_" + `${targetDte}_${tol}_${band}_${minVol}_${p.liquid_only ? "L" : "A"}_${limit}`, QUERY_TTL_MS)) as Row[];
  return {
    notebook: "45-day-premium-leaders", target_dte: targetDte, tolerance: tol,
    moneyness_band: band, min_volume: minVol,
    calls: rows.filter((r) => r.type === "call"), puts: rows.filter((r) => r.type === "put"),
  };
}

// ---------------------------------------------------------------------------
// News — /api/news (Tavily news search proxy)
// ---------------------------------------------------------------------------
// Narrative half of "why is this moving" for the AI copilot: per-ticker
// headlines via Tavily's licensed news-search API. The worker holds the
// TAVILY_API_KEY secret (server-side — never reaches the browser, unlike the
// unofficial Yahoo/Bing RSS endpoints it replaces). Tavily returns
// relevance-sorted, symbol-scoped results, which we strip to
// {title, link, published, snippet, source}. Upstream failures degrade to an
// empty item list with an error string — never a 500 — so a chat turn is
// never blocked by a news outage. Results are memoized in-isolate for 10 min
// keyed by symbol (only successes cache; failures retry on the next call).
const NEWS_TTL_MS = 10 * 60 * 1000;
const NEWS_DEFAULT_LIMIT = 8;
const NEWS_MAX_LIMIT = 20;
const NEWS_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]*$/;
const NEWS_SNIPPET_MAX = 240;
const TAVILY_API_URL = "https://api.tavily.com/search";
// News-only recency window (days) — keeps results current without spending the
// free monthly credit pool on stale stories.
const TAVILY_NEWS_DAYS = 7;

type NewsSource = "tavily";

interface NewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: NewsSource;
}

function truncateAtSentence(s: string, max = NEWS_SNIPPET_MAX): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max + 1);
  const boundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  return (boundary >= max * 0.6 ? window.slice(0, boundary + 1) : window).trimEnd();
}

async function tavilyNews(env: Env, symbol: string): Promise<NewsItem[]> {
  const response = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query: `${symbol} stock news`,
      topic: "news",
      search_depth: "basic",
      max_results: NEWS_MAX_LIMIT,
      days: TAVILY_NEWS_DAYS,
      include_answer: false,
      include_raw_content: false,
    }),
  });
  if (!response.ok) throw new Error(`tavily news returned HTTP ${response.status}`);
  const data = await response.json() as { results?: { title?: string; url?: string; content?: string; published_date?: string | null }[] };
  return (data.results ?? [])
    .map((r): NewsItem => ({
      title: (r.title ?? "").trim(),
      link: (r.url ?? "").trim(),
      published: r.published_date || null,
      snippet: truncateAtSentence((r.content ?? "").trim()),
      source: "tavily",
    }))
    .filter((it) => it.title)
    .slice(0, NEWS_MAX_LIMIT);
}

async function news(env: Env, symbolIn: string | null, limitIn: number): Promise<{
  symbol: string; items: NewsItem[]; source?: NewsSource; error?: string; fetched_at: string;
}> {
  const symbol = (symbolIn ?? "").trim().toUpperCase();
  const fetchedAt = () => new Date().toISOString();
  if (!NEWS_SYMBOL_RE.test(symbol)) {
    return { symbol, items: [], error: "invalid symbol", fetched_at: fetchedAt() };
  }
  const limit = clamp(limitIn || NEWS_DEFAULT_LIMIT, 1, NEWS_MAX_LIMIT);
  try {
    const items = await cached<NewsItem[]>(`news:${symbol}`, NEWS_TTL_MS, () => tavilyNews(env, symbol));
    return { symbol, items: items.slice(0, limit), source: "tavily", fetched_at: fetchedAt() };
  } catch (error) {
    return { symbol, items: [], error: String((error && (error as Error).message) || error), fetched_at: fetchedAt() };
  }
}

// ---------------------------------------------------------------------------
// Web search — /api/web_search (Tavily general search proxy)
// ---------------------------------------------------------------------------
// Open-ended web search for fresh analyst/market commentary beyond the
// per-ticker news feed: "what are analysts saying about X", "what happened
// with sector Y", "latest take on theme Z". Same Tavily key + proxy shape as
// /api/news but without the news-topic pin or recency window, so the model can
// surface current articles/notes with citable links. Results are stripped to
// {title, link, snippet, source}, capped at 5, snippets trimmed to ~240 chars,
// and memoized in-isolate for 10 min keyed by the lowercased query (only
// successes cache — failures retry on the next call). Upstream failures
// degrade to a 200 with an empty `results` list + `error` — never a 500 — so a
// search outage cannot block a chat turn.
const WEB_SEARCH_TTL_MS = 10 * 60 * 1000;
const WEB_SEARCH_DEFAULT_LIMIT = 5;
const WEB_SEARCH_MAX_LIMIT = 5;
const WEB_SEARCH_QUERY_MAX = 200;

interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  source: string | null;
}

async function tavilySearch(env: Env, query: string): Promise<WebSearchResult[]> {
  const response = await fetch(TAVILY_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      include_answer: false,
      include_raw_content: false,
      search_depth: "basic",
      max_results: WEB_SEARCH_MAX_LIMIT,
    }),
  });
  if (!response.ok) throw new Error(`tavily search returned HTTP ${response.status}`);
  const data = await response.json() as { results?: { title?: string; url?: string; content?: string; source?: string | null }[] };
  return (data.results ?? [])
    .map((r): WebSearchResult => ({
      title: (r.title ?? "").trim(),
      link: (r.url ?? "").trim(),
      snippet: truncateAtSentence((r.content ?? "").trim()),
      source: (r.source ?? "").trim() || null,
    }))
    .filter((it) => it.title)
    .slice(0, WEB_SEARCH_MAX_LIMIT);
}

async function webSearch(env: Env, queryIn: string | null, limitIn: number): Promise<{
  query: string; results: WebSearchResult[]; error?: string; fetched_at: string;
}> {
  const query = (queryIn ?? "").trim();
  const fetchedAt = () => new Date().toISOString();
  if (!query || query.length > WEB_SEARCH_QUERY_MAX) {
    return { query, results: [], error: "invalid query", fetched_at: fetchedAt() };
  }
  const limit = clamp(limitIn || WEB_SEARCH_DEFAULT_LIMIT, 1, WEB_SEARCH_MAX_LIMIT);
  try {
    const results = await cached<WebSearchResult[]>(`websearch:${query.toLowerCase()}`, WEB_SEARCH_TTL_MS, () => tavilySearch(env, query));
    return { query, results: results.slice(0, limit), fetched_at: fetchedAt() };
  } catch (error) {
    return { query, results: [], error: String((error && (error as Error).message) || error), fetched_at: fetchedAt() };
  }
}

// ---------------------------------------------------------------------------
// IV rank / percentile — /api/iv_rank
// ---------------------------------------------------------------------------
// "Is this IV expensive or cheap vs its own history?" The lake is append-only
// with intraday chain snapshots, so per-symbol ATM-IV history exists. One
// pre-aggregated query collapses each day to a single ATM-IV point (GROUP BY
// fetched_at date dedupes the ~15-min snapshots), then rank_pct is the
// fraction of the daily series at or below today's median — computed in JS.
// Bounded (per-symbol + window cap) and cached 60 min; lake errors degrade to
// a 200 with `points: []` + `error`, matching the /api/news contract.
const IV_RANK_TTL_MS = 60 * 60 * 1000;
const IV_RANK_DEFAULT_DAYS = 90;
const IV_RANK_MAX_DAYS = 120;
// Near-ATM moneyness band (5%) — pick the liquid, at-the-money contracts.
const IV_RANK_ATM_BAND = 0.05;

interface IvRankPoint { d: string; iv: number | null; }

interface IvRankResponse {
  symbol: string;
  days: number;
  points: IvRankPoint[];
  rank_pct: number | null;
  iv_now: number | null;
  iv_median: number | null;
  iv_min: number | null;
  iv_max: number | null;
  as_of: string | null;
  error?: string;
}

async function ivRank(env: Env, symbolIn: string | null, daysIn: number): Promise<IvRankResponse> {
  const symbol = (symbolIn ?? "").trim().toUpperCase();
  const days = clamp(daysIn || IV_RANK_DEFAULT_DAYS, 1, IV_RANK_MAX_DAYS);
  if (!NEWS_SYMBOL_RE.test(symbol)) {
    return { symbol, days, points: [], rank_pct: null, iv_now: null, iv_median: null, iv_min: null, iv_max: null, as_of: null, error: "invalid symbol" };
  }
  // option_contracts has no spot column — the near-ATM band compares each
  // contract's strike against the symbol's latest underlying spot, joined via
  // LATEST_UNDERLYING (same pattern as the screen's moneyness filter).
  const sql =
    `SELECT CAST(c.fetched_at AS DATE) AS d, approx_median(c.implied_vol) AS iv ` +
    `FROM options.option_contracts c ` +
    `JOIN (${LATEST_UNDERLYING}) u ON u.symbol = c.symbol ` +
    `WHERE c.symbol = ${lit(symbol)} AND c.implied_vol IS NOT NULL ` +
    `AND u.spot_price IS NOT NULL AND u.spot_price > 0 ` +
    `AND ABS(c.strike - u.spot_price) / u.spot_price <= ${IV_RANK_ATM_BAND} ` +
    `AND CAST(c.fetched_at AS DATE) >= CAST(CURRENT_DATE - INTERVAL '${days}' DAY AS DATE) ` +
    `GROUP BY CAST(c.fetched_at AS DATE)`;
  try {
    const result = await cached<IvRankResponse>(`iv_rank:${symbol}:${days}`, IV_RANK_TTL_MS, async () => {
      const rows = await r2sql(env, sql);
      const points = rows
        .map((r) => ({ d: String(r.d), iv: numOrNull(r.iv) }))
        .sort((a, b) => a.d.localeCompare(b.d)); // chronological
      const ivs = points.map((p) => p.iv).filter((v): v is number => v != null);
      if (ivs.length === 0) {
        return { symbol, days, points, rank_pct: null, iv_now: null, iv_median: null, iv_min: null, iv_max: null, as_of: null };
      }
      const sorted = [...ivs].sort((a, b) => a - b);
      const iv_median = sorted[Math.floor(sorted.length / 2)];
      const iv_min = sorted[0];
      const iv_max = sorted[sorted.length - 1];
      const last = points[points.length - 1];
      const iv_now = last && last.iv != null ? last.iv : null;
      const rank_pct = iv_now != null ? ivs.filter((v) => v <= iv_now).length / ivs.length : null;
      return {
        symbol, days,
        points,
        rank_pct: rank_pct != null ? Math.round(rank_pct * 1000) / 1000 : null,
        iv_now, iv_median, iv_min, iv_max,
        as_of: last ? last.d : null,
      };
    });
    // cached() stores the error-less value; guarantee the shape typed here.
    return result;
  } catch (error) {
    return { symbol, days, points: [], rank_pct: null, iv_now: null, iv_median: null, iv_min: null, iv_max: null, as_of: null, error: String((error && (error as Error).message) || error) };
  }
}

// ---------------------------------------------------------------------------
// Macro / economic calendar — /api/econ_calendar
// ---------------------------------------------------------------------------
// "Binary-event weeks" (FOMC, CPI, jobs, PCE) lift broad implied vol, so the
// Copilot gets the upcoming scheduled releases. With FRED_API_KEY set, the
// endpoint matches the curated high-impact macro release names (exact —
// see below) from FRED's releases/dates API and merges in FOMC/Beige events
// from the Fed's keyless calendar JSON (FRED emits daily placeholders for
// unscheduled press releases, so FOMC dates come from the Fed calendar, which
// pre-schedules them accurately). Without a key, only the Fed calendar is
// used. Cached 12h: release schedules move on a quarterly-ish cadence and the
// Fed JSON is ~0.5MB. Same degrade-to-empty contract as the other endpoints.
const ECON_TTL_MS = 12 * 60 * 60 * 1000;
const ECON_DEFAULT_DAYS = 30;
const ECON_MAX_DAYS = 90;
// Source tag on options.econ_calendar rows (matches loader/src/econ.ts) —
// used to derive the response `provider` from merged lake rows.
const ECON_SOURCE_FRED = "fred";
const FRED_API_URL = "https://api.stlouisfed.org/fred/releases/dates";
const FED_CALENDAR_URL = "https://www.federalreserve.gov/json/calendar.json";
// Exact-match allowlist of high-impact macro releases. Substring matching
// pulls in lookalikes ("Research Consumer Price Index", "Debt to Gross
// Domestic Product Ratios"), and with include_release_dates_with_no_data=true
// FRED returns a placeholder holder date for *every* day for unscheduled
// press-release-style releases ("FOMC Press Release" appears daily) — hence
// FOMC/Beige are sourced from the Fed calendar instead.
const ECON_FRED_RELEASES = new Set([
  "Consumer Price Index",
  "Producer Price Index",
  "Employment Situation",
  "Personal Income and Outlays",
  "Gross Domestic Product",
  "Surveys of Consumers",
]);
// Fed-calendar event types that move broad vol (the rest are weekly H-stat
// releases, speeches, and testimonies).
const FED_CALENDAR_TYPES = new Set(["FOMC", "Beige"]);

interface EconCalendarEvent { date: string; title: string; kind: "macro" | "fed"; time?: string; }

interface EconCalendarResponse {
  window_days: number;
  as_of: string;
  provider: "fred" | "federalreserve";
  items: EconCalendarEvent[];
  error?: string;
}

// Upcoming FOMC (meetings/statements/minutes/press conferences) + Beige Book
// from the Fed's keyless calendar JSON. Date = `month` + `days`; `days` can be
// a comma list for recurring releases (take the first). `time` is the Fed's ET
// wall-clock release time, normalized to "HH:MM" (matches the lake's
// options.econ_calendar.event_time).
function normalizeEventTime(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)$/i.exec(raw.trim());
  if (!m) return undefined;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
async function fedCalendarEvents(days: number): Promise<EconCalendarEvent[]> {
  const res = await fetch(FED_CALENDAR_URL);
  if (!res.ok) throw new Error(`federalreserve calendar returned HTTP ${res.status}`);
  const data = await res.json() as { events?: { title?: string; type?: string; month?: string; days?: string; time?: string }[] };
  const now = Date.now();
  const endMs = now + days * 86400_000;
  const items: EconCalendarEvent[] = [];
  for (const e of data.events ?? []) {
    if (!FED_CALENDAR_TYPES.has(e.type ?? "")) continue;
    const day = Number((e.days ?? "").split(",")[0].trim());
    if (!Number.isFinite(day) || day < 1 || day > 31) continue;
    const m = /^(\d{4})-(\d{2})$/.exec(e.month ?? "");
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${String(day).padStart(2, "0")}`;
    const ts = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(ts) || ts < now || ts > endMs) continue;
    const time = normalizeEventTime(e.time);
    items.push({ date, title: (e.title ?? "").trim() || String(e.type ?? ""), kind: "fed", ...(time ? { time } : {}) });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

async function econCalendar(env: Env, daysIn: number): Promise<EconCalendarResponse> {
  const days = clamp(daysIn || ECON_DEFAULT_DAYS, 1, ECON_MAX_DAYS);
  const asOf = () => new Date().toISOString();
  try {
    return await cached<EconCalendarResponse>(`econ:${days}`, ECON_TTL_MS, async () => {
      // Primary path: read the upcoming window from the lake's econ_calendar
      // table (fred-econ-daily job → options.econ_calendar), newest run per
      // (event_date, title). Fall back to the live FRED/Fed fetch when the
      // table is missing or empty (e.g. before the first sync lands).
      const now = Date.now();
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const start = iso(new Date(now - 86400_000));
      const end = iso(new Date(now + days * 86400_000));
      let lakeItems: { date: string; title: string; kind: "macro" | "fed" }[] = [];
      let lakeProvider: "fred" | "federalreserve" | null = null;
      try {
        const rows = await r2sql(
          env,
          "WITH latest AS (" +
            "SELECT event_date, title, kind, source, event_time, fetched_at, " +
            "ROW_NUMBER() OVER (PARTITION BY event_date, title ORDER BY fetched_at DESC) rn " +
            "FROM options.econ_calendar) " +
            `SELECT event_date, title, kind, source, event_time FROM latest ` +
            `WHERE rn = 1 AND event_date >= ${lit(start)} AND event_date <= ${lit(end)} ` +
            `ORDER BY event_date, title LIMIT ${R2SQL_LIMIT_MAX}`,
          "econ_lake:" + days,
          QUERY_TTL_MS,
        );
        if (rows.length > 0) {
          lakeItems = rows.map((r) => ({
            date: String(r.event_date),
            title: String(r.title),
            kind: r.kind === "fed" ? "fed" : "macro",
            ...(r.event_time ? { time: String(r.event_time) } : {}),
          }));
          lakeProvider = rows.some((r) => r.source === ECON_SOURCE_FRED)
            ? "fred"
            : "federalreserve";
        }
      } catch (error) {
        // Lake missing/empty — fall through to the live fetch below.
        console.log(`econ lake read failed (${String((error && (error as Error).message) || error)}) — falling back to live fetch`);
      }
      if (lakeItems.length > 0) {
        return { window_days: days, as_of: asOf(), provider: lakeProvider!, items: lakeItems };
      }
      // Fallback: live FRED releases/dates + Fed calendar (original behavior).
      if (env.FRED_API_KEY) {
        const end2 = new Date(now + days * 86400_000);
        const url =
          `${FRED_API_URL}?api_key=${encodeURIComponent(env.FRED_API_KEY)}&file_type=json` +
          `&realtime_start=${iso(new Date(now - 86400_000))}&realtime_end=${iso(end2)}` +
          `&include_release_dates_with_no_data=true&sort_order=asc&limit=1000`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fred releases/dates returned HTTP ${res.status}`);
        const data = await res.json() as { release_dates?: { release_name?: string; date?: string }[] };
        const items: EconCalendarEvent[] = (data.release_dates ?? [])
          .filter((r) => r.date && r.release_name && ECON_FRED_RELEASES.has(r.release_name))
          .map((r): EconCalendarEvent => ({ date: String(r.date), title: String(r.release_name).trim(), kind: "macro" }))
          .concat(await fedCalendarEvents(days))
          .sort((a, b) => a.date.localeCompare(b.date));
        return { window_days: days, as_of: asOf(), provider: "fred", items };
      }
      const items = await fedCalendarEvents(days);
      return { window_days: days, as_of: asOf(), provider: "federalreserve", items };
    });
  } catch (error) {
    return { window_days: days, as_of: asOf(), provider: env.FRED_API_KEY ? "fred" : "federalreserve", items: [], error: String((error && (error as Error).message) || error) };
  }
}
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function numOrNull(v: unknown): number | null { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; }
function strOrNull(v: unknown): string | null { return v == null ? null : String(v); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n))); }
function sortedUnique(arr: string[]): string[] { return Array.from(new Set(arr)).sort(); }


// ---------------------------------------------------------------------------
// Copilot chat history — capture + admin-only read
// ---------------------------------------------------------------------------
// The browser posts each completed chat turn to POST /api/chat/history; the
// worker normalizes it and publishes one record per turn to the
// cboe_chat_history_v2 stream → options.chat_history (append-only, one row
// per turn with the full conversation so far under the conversation's
// chat_id — consumers keep the newest row per chat_id, the lake's standard
// latest-wins pattern).
//
// Access control. The table is PRIVATE: it is excluded from /api/tables (see
// PRIVATE_LAKE_TABLES above) and /api/query refuses any SQL referencing it
// unless the request carries the admin token. The only read path is
// GET /api/admin/chat_history (Bearer ADMIN_TOKEN) — no admin UI, the
// endpoint is the admin surface.
//
// Capture is best-effort and server-side. `ip` (CF-Connecting-IP) and
// `user_agent` (request header) are recorded for abuse tracking and are never
// accepted from the client body. `user_id` is intentionally NOT populated
// (no login yet) — the column is reserved for the future per-user history
// feature, where the worker will set it from the auth session, never from the
// client. Records are buffered in D1 (pending_chat_history, migration 0002)
// BEFORE the response and published in a background waitUntil task, so the
// pipeline's occasionally-slow ingest never holds a browser connection slot;
// failures leave the row pending and a later call drains it (no transcript
// loss). A chat is never blocked by history persistence: all failures return
// 2xx to the browser.
const CHAT_HISTORY_MAX_MESSAGES = 100;
const CHAT_HISTORY_MAX_CONTENT = 20_000; // chars per message / sql / url
const CHAT_HISTORY_MAX_AUX = 512; // ip / user_agent / chat_id / model length
const CHAT_HISTORY_DRAIN_BATCH = 10; // pending rows re-published per call
const CHAT_HISTORY_MAX_ATTEMPTS = 5; // per pending row, then left for manual
const PIPELINE_HTTP_RETRIES = 3; // mirror the loader's requestJson retry policy
const PIPELINE_RETRY_BACKOFF_MS = 500;
// Hard cap on a single ingest POST so a stalled pipeline can never hold a
// browser connection slot indefinitely (the browser fires the history save
// fire-and-forget; a hung fetch would occupy one of Chromium's per-host
// connections and could delay the user's NEXT api call). Missed ingest →
// D1 buffer + later drain, so timeout-safe.
const PIPELINE_POST_TIMEOUT_MS = 10_000;
const LOADER_UA = "cboe-to-r2/0.2"; // loader User-Agent convention for Pipeline POSTs
const CHAT_HISTORY_ADMIN_LIMIT_MAX = 500;

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Constant-time string comparison for the admin token (length is not secret). */
function secureEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** True when the request carries the ADMIN_TOKEN bearer secret. */
function adminAuthorized(req: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token.length > 0 && secureEqual(token, expected);
}

// Get the messages array out of an unknown JSON node (each entry is an object
// or we throw — a malformed transcript is a client bug, reject it).
function chatMessageRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new Error("each message must be an object");
}

/** Validate + normalize a client transcript into a lake record. Throws on bad input. */
function normalizeChatHistoryRecord(
  body: Record<string, unknown>,
  ip: string,
  ua: string,
): Record<string, unknown> {
  const chatId = str(body.chat_id)?.trim().slice(0, CHAT_HISTORY_MAX_AUX);
  if (!chatId) throw new Error("chat_id is required");
  const mode = str(body.mode);
  if (mode !== "funded") throw new Error("mode must be 'funded'");
  const startedAt = str(body.started_at)!;
  const endedAt = str(body.ended_at)!;
  if (!startedAt || !endedAt || !Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt)))
    throw new Error("started_at and ended_at must be ISO timestamps");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    throw new Error("messages must be a non-empty array");

  // Strip to {role, content, sql?, ts?} — drops bulky UI state (query result
  // tables, chart specs, error stacks) that would bloat the record and has no
  // analytic value; content/sql are the history.
  const messages = body.messages.slice(0, CHAT_HISTORY_MAX_MESSAGES).map((m) => {
    const rec = chatMessageRecord(m);
    const role = rec.role;
    if (role !== "user" && role !== "assistant") throw new Error("each message needs role 'user' | 'assistant'");
    const out: Record<string, unknown> = {
      role,
      content: typeof rec.content === "string" ? rec.content.slice(0, CHAT_HISTORY_MAX_CONTENT) : "",
    };
    if (typeof rec.sql === "string" && rec.sql) out.sql = rec.sql.slice(0, CHAT_HISTORY_MAX_CONTENT);
    if (typeof rec.ts === "number" && Number.isFinite(rec.ts)) out.ts = rec.ts;
    return out;
  });

  const record: Record<string, unknown> = {
    chat_id: chatId,
    mode,
    started_at: startedAt,
    ended_at: endedAt,
    messages: JSON.stringify(messages),
    source: "copilot",
    fetched_at: new Date().toISOString(),
  };
  const model = str(body.model)?.trim().slice(0, CHAT_HISTORY_MAX_AUX);
  if (model) record.model = model;
  if (ip) record.ip = ip;
  if (ua) record.user_agent = ua;
  return record;
}

// POST a payload to a Pipeline stream with the loader User-Agent, idempotency
// key and retry/backoff parity with the loader's requestJson (retry only on
// 5xx/transport; 4xx hard-fails). The idempotency key is only sent when a
// token is present (same as the loader).
async function pipelinePost(
  env: Env,
  url: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<void> {
  const authToken = env.PIPELINE_AUTH_TOKEN || "";
  let lastErr: unknown = new Error("pipeline post failed");
  for (let attempt = 0; attempt <= PIPELINE_HTTP_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": LOADER_UA,
          ...(authToken
            ? { authorization: `Bearer ${authToken}`, "idempotency-key": idempotencyKey }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PIPELINE_POST_TIMEOUT_MS),
      });
      if (res.ok) return;
      if (res.status < 500) throw new Error(`pipeline rejected record (HTTP ${res.status})`);
      lastErr = new Error(`pipeline HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < PIPELINE_HTTP_RETRIES) {
      await new Promise((r) => setTimeout(r, PIPELINE_RETRY_BACKOFF_MS * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Publish ONE pending row, deleting it once the pipeline accepts the record.
// Failures increment `attempts` (capped at CHAT_HISTORY_MAX_ATTEMPTS; beyond
// the cap the row is left for manual inspection). Returns nothing — errors
// are logged and absorbed (this runs in the background).
async function publishPendingRow(env: Env, row: { id: number; chat_id: string; payload: string; attempts: number }): Promise<void> {
  if (!env.PIPELINE_CHAT_HISTORY_URL) return;
  try {
    await pipelinePost(env, env.PIPELINE_CHAT_HISTORY_URL, JSON.parse(row.payload), `chat:${row.chat_id}`);
    await env.SCHEMA_DB.prepare("DELETE FROM pending_chat_history WHERE id = ?1").bind(row.id).run();
  } catch (e) {
    console.error("pending chat-history publish failed", e);
    if (row.attempts < CHAT_HISTORY_MAX_ATTEMPTS) {
      await env.SCHEMA_DB.prepare(
        "UPDATE pending_chat_history SET attempts = attempts + 1 WHERE id = ?1",
      ).bind(row.id).run();
    }
  }
}

// Re-publish buffered pending_chat_history rows (oldest first). Never throws —
// run via ctx.waitUntil.
async function drainPendingChatHistory(env: Env): Promise<void> {
  if (!env.PIPELINE_CHAT_HISTORY_URL) return;
  try {
    const rows = await env.SCHEMA_DB.prepare(
      "SELECT id, chat_id, payload, attempts FROM pending_chat_history ORDER BY created_at ASC LIMIT ?1",
    ).bind(CHAT_HISTORY_DRAIN_BATCH).all<{ id: number; chat_id: string; payload: string; attempts: number }>();
    for (const row of rows.results ?? []) {
      await publishPendingRow(env, row);
    }
  } catch (e) {
    console.error("pending chat-history drain failed", e);
  }
}

/**
 * POST /api/chat/history — capture one completed chat turn into the lake.
 *
 * Durability-first: the normalized record is buffered in D1 (pending_chat_history)
 * BEFORE the response, then published to the pipeline in a background
 * waitUntil task (the pipeline POST can take ~1s — occasionally much longer —
 * and must never hold the browser's connection slot: the browser fires this
 * fire-and-forget and other API calls share Chromium's per-host connections).
 * A background failure leaves the row pending (attempts+1); a later
 * /api/chat/history call's drain re-publishes it, so no transcript is lost.
 */
async function saveChatHistory(env: Env, ctx: ExecutionContext, req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json(env, { ok: false, error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(env, { ok: false, error: "invalid JSON body" }, 400);
  }

  // Abuse-tracking metadata is captured server-side only — never trusted from
  // the client body. CF-Connecting-IP is set by Cloudflare on every request.
  const ip = (req.headers.get("CF-Connecting-IP") ?? "").slice(0, CHAT_HISTORY_MAX_AUX);
  const ua = (req.headers.get("User-Agent") ?? "").slice(0, CHAT_HISTORY_MAX_AUX);

  let record: Record<string, unknown>;
  try {
    record = normalizeChatHistoryRecord(body, ip, ua);
  } catch (e) {
    return json(env, { ok: false, error: String((e && (e as Error).message) || e) }, 400);
  }

  if (!env.PIPELINE_CHAT_HISTORY_URL) {
    // Not configured (local dev without secrets): accept the turn silently so
    // history capture never breaks a chat.
    return json(env, { ok: true, stored: false }, 200);
  }

  let rowId: number;
  let payload: string;
  try {
    payload = JSON.stringify(record);
    const inserted = await env.SCHEMA_DB.prepare(
      "INSERT INTO pending_chat_history (chat_id, payload, attempts, created_at) VALUES (?1, ?2, 0, ?3)",
    ).bind(record.chat_id, payload, Date.now()).run();
    rowId = Number(inserted.meta.last_row_id);
  } catch (dbErr) {
    // D1 down — drop the record rather than hold the request (capture is
    // best-effort by design; a chat is never blocked by history persistence).
    console.error("pending chat-history buffer failed", dbErr);
    return json(env, { ok: true, stored: false, error: "buffer unavailable" }, 202);
  }

  // Background publish (new row first, then any backlog) — never in the path.
  ctx.waitUntil((async () => {
    await publishPendingRow(env, { id: rowId, chat_id: String(record.chat_id), payload, attempts: 0 });
    await drainPendingChatHistory(env);
  })());
  return json(env, { ok: true, stored: true });
}

/** GET /api/admin/chat_history — newest-first transcripts (Bearer ADMIN_TOKEN). */
async function adminChatHistory(
  env: Env,
  limitIn: number,
  beforeIn: string | null,
): Promise<{
  ok: boolean;
  limit: number;
  before: string | null;
  items: { chat_id: string; mode: string; model: string | null; user_id: string | null; ip: string | null; user_agent: string | null; started_at: string; ended_at: string; source: string; fetched_at: string; messages: unknown }[];
  as_of: string;
}> {
  const limit = clamp(limitIn || 100, 1, CHAT_HISTORY_ADMIN_LIMIT_MAX);
  const before = beforeIn && Number.isFinite(Date.parse(beforeIn)) ? beforeIn : null;
  // No cache key: rows land within seconds of a chat, so admin reads must be
  // live. `before` is an ISO fetched_at cursor (R2 SQL has no OFFSET).
  //
  // The lake is append-only and the stream does not dedupe on idempotency key:
  // a publish-success-but-timeout leaves a row pending and a later drain
  // re-publishes the SAME chat_id (one row per chat turn, so each turn's row
  // carries the full conversation so far). Collapse to the NEWEST row per
  // chat_id (the complete conversation) — the lake's standard latest-wins
  // QUALIFY pattern — so the admin view shows one transcript per chat.
  const where = before ? `WHERE fetched_at < ${lit(before)}` : "";
  const rows = await r2sql(env,
    `SELECT chat_id, mode, model, user_id, ip, user_agent, started_at, ended_at, messages, source, fetched_at ` +
    `FROM options.chat_history ${where} ` +
    `QUALIFY ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY fetched_at DESC, ended_at DESC) = 1 ` +
    `ORDER BY fetched_at DESC, ended_at DESC LIMIT ${limit}`);
  const items = rows.map((r) => {
    let messages: unknown = null;
    try {
      messages = JSON.parse(String(r.messages ?? "null"));
    } catch {
      messages = null;
    }
    return {
      chat_id: String(r.chat_id),
      mode: String(r.mode),
      model: strOrNull(r.model),
      user_id: strOrNull(r.user_id),
      ip: strOrNull(r.ip),
      user_agent: strOrNull(r.user_agent),
      started_at: String(r.started_at),
      ended_at: String(r.ended_at),
      source: String(r.source),
      fetched_at: String(r.fetched_at),
      messages,
    };
  });
  return { ok: true, limit, before, items, as_of: new Date().toISOString() };
}

// How long a resumed chat result stays readable after the producing turn
// finished. Generous enough for a user to unlock the phone and come back to a
// suspended tab; chat_ids are unguessable, so rows are effectively private and
// lazily pruned on every read.
const CHAT_RESULT_TTL_MS = 60 * 60_000;
const CHAT_RESULT_CHAT_ID_MAX = 128; // mirror the /api/chat chat_id validation

/** Store a completed Copilot result (payload = the SSE `result` event JSON). */
async function persistChatResult(env: Env, chatId: string, payload: string): Promise<void> {
  if (!env.SCHEMA_DB) return;
  await env.SCHEMA_DB
    .prepare("INSERT OR REPLACE INTO chat_results (chat_id, payload, created_at) VALUES (?1, ?2, ?3)")
    .bind(chatId, payload, Date.now())
    .run();
}

/**
 * GET /api/chat/result?chat_id=… — resume a result the browser missed because
 * its SSE connection died (mobile background) before the final event. Returns
 * the stored `result` event payload as `{ ready: true, ... }` once the Worker
 * has finished and persisted it, else `{ ready: false }`. chat_id is the
 * capability (unguessable client UUID) — same trust model as /api/share/*.
 */
async function getChatResult(env: Env, chatIdIn: string): Promise<Response> {
  const chatId = chatIdIn.trim().slice(0, CHAT_RESULT_CHAT_ID_MAX);
  if (!chatId) return json(env, { error: "chat_id is required" }, 400);
  const now = Date.now();
  if (!env.SCHEMA_DB) return json(env, { ready: false });
  // Prune this chat's own expired row (idempotent; a live chat is untouched).
  await env.SCHEMA_DB.prepare("DELETE FROM chat_results WHERE chat_id = ?1 AND created_at < ?2").bind(chatId, now - CHAT_RESULT_TTL_MS).run();
  const row = await env.SCHEMA_DB.prepare("SELECT payload FROM chat_results WHERE chat_id = ?1").bind(chatId).first<{ payload: string }>();
  if (!row) return json(env, { ready: false });
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return json(env, { ready: false });
  }
  return json(env, { ready: true, ...(payload as Record<string, unknown>) });
}

// ---------------------------------------------------------------------------
// Copilot chat shares — public unlisted transcripts in D1
// ---------------------------------------------------------------------------
// POST /api/share/chat snapshots a conversation (the same ChatHistoryRecord
// shape the lake capture uses, normalized by the SAME pass-1 normalizer) into
// shared_chats (migration 0003) and returns /share/<share_id>. The share_id
// is base62 of 18 random bytes — high entropy makes the URL an implicit
// capability: anyone with the link can view, nobody can enumerate. Unlike the
// best-effort lake capture, a share is explicitly user-requested, so it
// either succeeds or fails loudly (502 on D1 failure, 413/429 on budget/rate)
// letting the user retry. No auth — the id is the key; reads are cached
// public, max-age=60 via json().
//
// Row budgets. D1 caps a row at 2,000,000 bytes, and the lake strike caps are
// LOOSER than that allows (100 msg × 20k content + 20k sql → ~4 MB worst
// case). Pass 2 (normalizeShareRecord) applies share-only tightening (content
// ≤ 5,000 chars, sql ≤ 10,000 chars, ≤ 20 tool entries per message), then
// truncates OLDEST turns first when the serialized messages JSON exceeds 1.2
// MB of UTF-8 bytes, then verifies the assembled row stays under the 2 MB D1
// ceiling before INSERT. All sizes are UTF-8 BYTES (TextEncoder.byteLength) —
// JS string length counts UTF-16 units, and CJK/emoji expand 2–3× per unit,
// which would overflow the row silently.
//
// Abuse levers (no client fingerprinting — the site's privacy stance is "no
// login, no personal data"): created_ip/created_ua set server-side from the
// request headers and NEVER served; oversized raw bodies rejected (413) before
// JSON.parse; and a D1-backed per-IP rate check (429) that survives isolate
// recycling. An in-isolate Map is only a cheap first filter, never a
// stand-alone control.
const SHARE_RAW_BODY_MAX = 1_300_000;       // reject raw body before JSON.parse (413)
const SHARE_MESSAGES_MAX_BYTES = 1_200_000; // serialized messages JSON, UTF-8 bytes
const SHARE_ROW_MAX_BYTES = 2_000_000;      // D1 row ceiling (messages + source_sql + columns)
const SHARE_MAX_CONTENT = 5_000;            // chars — per message content
const SHARE_MAX_SQL = 10_000;               // chars — per message sql
const SHARE_MAX_TOOLS = 20;                 // tool entries per message
const SHARE_MAX_TOOL_ARG = 2_000;           // chars — per tool args
const SHARE_MAX_TITLE = 120;                // chars — auto-derived title
const SHARE_RATE_WINDOW_MS = 10 * 60_000;   // per-IP window
const SHARE_RATE_LIMIT = 20;                // shares per window per IP
const SHARE_ID_BYTES = 18;
const SHARE_ID_RE = /^[0-9A-Za-z]{1,48}$/;  // base62 slug; rejects junk lookups
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** UTF-8 byte length of a string (D1 row/message caps are byte budgets). */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** base62 of N random bytes — the URL slug / implicit capability. */
function base62Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62_ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out || "0";
}

// In-isolate first filter only (per-IP recent-share timestamps). NOT a
// stand-alone control: it dies with the isolate and consecutive requests from
// one IP routinely land on different isolates — the D1 COUNT in createShare
// is the authoritative check.
const shareRateLocal = new Map<string, number[]>();
function shareRateHitLocal(ip: string): boolean {
  if (!ip) return false;
  const t = Date.now();
  if (shareRateLocal.size > 10_000) {
    // Sweep stale entries so a many-IP fan-out can't grow the map unboundedly.
    for (const [k, v] of shareRateLocal) {
      const alive = v.filter((ts) => t - ts < SHARE_RATE_WINDOW_MS);
      if (alive.length === 0) shareRateLocal.delete(k);
      else shareRateLocal.set(k, alive);
    }
  }
  const list = (shareRateLocal.get(ip) ?? []).filter((ts) => t - ts < SHARE_RATE_WINDOW_MS);
  shareRateLocal.set(ip, list);
  return list.length >= SHARE_RATE_LIMIT;
}
function shareRateRecordLocal(ip: string): void {
  if (!ip) return;
  const list = shareRateLocal.get(ip) ?? [];
  list.push(Date.now());
  shareRateLocal.set(ip, list);
}

/**
 * Pass 2 — share-only tightening on top of the lake normalizer's output.
 * The shipped caps (20k chars, no byte budget) are looser than the D1 row
 * allows, so every message gets the tighter per-field caps here, then the
 * serialized JSON is trimmed to the 1.2 MB byte budget (oldest turns first,
 * then older assistant sql). Returns the trimmed messages + the denormalized
 * source_sql (last assistant sql, the future-alerts keystone) + auto title
 * (first user question). Never throws.
 */
function normalizeShareRecord(pass1: Record<string, unknown>): {
  messages: Record<string, unknown>[];
  sourceSql: string | null;
  title: string | null;
} {
  const messages = (JSON.parse(String(pass1.messages)) as unknown[]).map((m) => {
    const rec = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    const role = rec.role === "assistant" ? "assistant" : "user";
    const out: Record<string, unknown> = { role };
    if (typeof rec.content === "string" && rec.content) out.content = rec.content.slice(0, SHARE_MAX_CONTENT);
    if (typeof rec.sql === "string" && rec.sql) out.sql = rec.sql.slice(0, SHARE_MAX_SQL);
    if (typeof rec.ts === "number" && Number.isFinite(rec.ts)) out.ts = rec.ts;
    if (Array.isArray(rec.tools)) {
      // The schema tolerates tools (future ToolRow capture); v1 client never
      // sends them, so this is a defensive cap, not a UI feature.
      const tools = rec.tools
        .slice(0, SHARE_MAX_TOOLS)
        .map((t) => {
          const tr = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
          const name = str(tr.name)?.slice(0, 80) ?? "";
          if (!name) return null;
          const tool: Record<string, unknown> = { name };
          if (typeof tr.args === "string" && tr.args) tool.args = tr.args.slice(0, SHARE_MAX_TOOL_ARG);
          if (tr.ok === true || tr.ok === false) tool.ok = tr.ok;
          if (tr.summary != null && tr.summary !== "") tool.summary = str(tr.summary)!.slice(0, 500);
          return tool;
        })
        .filter((t): t is Record<string, unknown> => t !== null);
      if (tools.length) out.tools = tools;
    }
    return out;
  });

  const title =
    (messages.find((m) => m.role === "user" && typeof m.content === "string" && m.content)?.content as
      | string
      | undefined)?.slice(0, SHARE_MAX_TITLE) ?? null;

  // Byte budget: drop oldest turns first (a share is judged by its tail),
  // then older sql, then hard-backstop truncation. The tighter per-field caps
  // bound a single message far below the budget, so the loop is deterministic.
  const bytes = () => utf8Bytes(JSON.stringify(messages));
  while (messages.length > 1 && bytes() > SHARE_MESSAGES_MAX_BYTES) messages.shift();
  if (bytes() > SHARE_MESSAGES_MAX_BYTES) {
    for (const m of [...messages].reverse()) delete m.sql; // newest last to lose sql
  }
  if (bytes() > SHARE_MESSAGES_MAX_BYTES) {
    for (const m of [...messages].reverse()) delete m.tools;
  }
  let guard = 0;
  while (bytes() > SHARE_MESSAGES_MAX_BYTES && messages.length > 0 && guard++ < 10_000) {
    const oldest = messages[0];
    const content = String(oldest.content ?? "");
    if (!content) {
      messages.shift(); // already empty — drop the turn
      continue;
    }
    oldest.content = content.slice(0, Math.floor(content.length / 2));
    if (!oldest.content) delete oldest.content;
  }

  const lastAssistant = [...messages].reverse().find(
    (m) => m.role === "assistant" && typeof m.sql === "string" && m.sql,
  );
  return { messages, sourceSql: lastAssistant ? String(lastAssistant.sql) : null, title };
}

/**
 * POST /api/share/chat — mint a public share for a conversation.
 * Body: the full ChatHistoryRecord (the lake capture shape — the pass-1
 * normalizer requires started_at/ended_at ISO timestamps + non-empty messages).
 */
async function createShare(env: Env, req: Request): Promise<Response> {
  // Oversized raw body → 413 before JSON.parse (bounds parse cost, keeps the
  // D1 row budget honest). Content-Length is byte-accurate when present; the
  // text() read re-checks actual UTF-8 byte length regardless.
  const contentLength = Number(req.headers.get("Content-Length") ?? "0");
  if (contentLength > SHARE_RAW_BODY_MAX) return json(env, { error: "payload too large" }, 413);
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json(env, { error: "invalid JSON body" }, 400);
  }
  if (utf8Bytes(raw) > SHARE_RAW_BODY_MAX) return json(env, { error: "payload too large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(env, { error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json(env, { error: "invalid JSON body" }, 400);
  }

  // Abuse signals set server-side only — never accepted from the body (the
  // exact chat-history capture pattern). CF-Connecting-IP is set by Cloudflare.
  const ip = (req.headers.get("CF-Connecting-IP") ?? "").slice(0, CHAT_HISTORY_MAX_AUX);
  const ua = (req.headers.get("User-Agent") ?? "").slice(0, CHAT_HISTORY_MAX_AUX);

  // Pass 1 — the SHARED lake normalizer, verbatim (identical validation and
  // failure modes to the R2 capture: mode, ISO timestamps, roles, caps).
  let pass1: Record<string, unknown>;
  try {
    pass1 = normalizeChatHistoryRecord(body, ip, ua);
  } catch (e) {
    return json(env, { error: String((e && (e as Error).message) || e) }, 400);
  }

  // Rate check: cheap in-isolate filter first, then the D1-backed COUNT that
  // survives isolate recycling and spans colocations (served by
  // idx_shared_chats_ip). 429 past the threshold — the honest lever for bulk
  // share creation.
  if (shareRateHitLocal(ip)) return json(env, { error: "rate limited" }, 429);
  const recent = await env.SCHEMA_DB.prepare(
    "SELECT COUNT(*) AS n FROM shared_chats WHERE created_ip = ?1 AND created_at > ?2",
  ).bind(ip, Date.now() - SHARE_RATE_WINDOW_MS).first<{ n: number }>();
  if ((recent?.n ?? 0) >= SHARE_RATE_LIMIT) return json(env, { error: "rate limited" }, 429);

  // Pass 2 — share-only tightening + budgets.
  const { messages, sourceSql, title } = normalizeShareRecord(pass1);
  const messagesJson = JSON.stringify(messages);
  // Assembled-row check: messages JSON + source_sql + column overhead must sit
  // under the D1 2 MB row ceiling — a share can never 500 on INSERT.
  const rowBytes = utf8Bytes(messagesJson) + utf8Bytes(sourceSql ?? "") + 512;
  if (rowBytes > SHARE_ROW_MAX_BYTES) return json(env, { error: "payload too large" }, 413);

  const shareId = base62Encode(crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES)));
  const now = Date.now();
  try {
    await env.SCHEMA_DB.prepare(
      `INSERT INTO shared_chats
         (share_id, chat_id, title, mode, model, messages, source_sql, created_ip, created_ua, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    ).bind(
      shareId,
      String(pass1.chat_id),
      title,
      String(pass1.mode),
      pass1.model ? String(pass1.model) : null,
      messagesJson,
      sourceSql,
      ip || null,
      ua || null,
      now,
    ).run();
  } catch (dbErr) {
    // Explicitly user-requested → fail LOUDLY so they can retry (unlike the
    // best-effort lake capture, where D1-buffering absorbs write failures).
    console.error("share create failed", dbErr);
    return json(env, { error: "storage unavailable" }, 502);
  }
  shareRateRecordLocal(ip);
  return json(env, { share_id: shareId, url: "/share/" + shareId });
}

/**
 * GET /api/share/:id — public read of a shared transcript. No auth (the
 * share_id is the capability); unknown or expired ids are indistinguishable
 * 404s. created_ip / created_ua are never selected — privacy by construction.
 */
async function getSharedChat(env: Env, shareId: string): Promise<Response> {
  if (!SHARE_ID_RE.test(shareId)) return json(env, { error: "not found" }, 404);
  const row = await env.SCHEMA_DB.prepare(
    `SELECT share_id, title, mode, model, messages, source_sql, created_at, expires_at
     FROM shared_chats WHERE share_id = ?1`,
  ).bind(shareId).first<{
    share_id: string;
    title: string | null;
    mode: string;
    model: string | null;
    messages: string;
    source_sql: string | null;
    created_at: number;
    expires_at: number | null;
  }>();
  if (!row) return json(env, { error: "not found" }, 404);
  if (row.expires_at && row.expires_at < Date.now()) return json(env, { error: "not found" }, 404);
  let messages: unknown = null;
  try {
    messages = JSON.parse(row.messages);
  } catch {
    /* rows are written by us; tolerate a corrupt one rather than 500 */
  }
  return json(env, {
    share_id: row.share_id,
    title: row.title,
    mode: row.mode,
    model: row.model,
    created_at: row.created_at,
    messages,
    source_sql: row.source_sql,
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Continuous-loader pass-through (read-only /loop endpoints)
// ---------------------------------------------------------------------------
const LOADER_BASE_DEFAULT = "https://cboe-to-r2.robertlancer.workers.dev";
// Short in-isolate cache so the UI's polling doesn't hammer the loader DO.
const LOADER_TTL_MS = 5 * 1000;

// Forwards a read-only /loop/* request to the continuous loader worker. The
// loader only Bearer-guards /loop/trigger and /loop/arm, so /loop/status and
// /loop/symbols are safe to proxy without a token.
async function loaderGet(env: Env, path: string, cacheKey: string): Promise<unknown> {
  const base = (env.LOADER_BASE_URL || LOADER_BASE_DEFAULT).replace(/\/+$/, "");
  return cached<unknown>(cacheKey, LOADER_TTL_MS, async () => {
    const r = await fetch(base + path);
    if (!r.ok) throw new Error(`loader ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  });
}

function cors(env: Env, resp: Response): Response {
  resp.headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN ?? "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // The API is CORS-open and never accepts browser credentials. Allow any
  // request header so the SSE chat client and future browser versions remain
  // compatible without exposing the server-side OpenRouter key.
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}

function json(env: Env, data: unknown, status = 200): Response {
  return cors(env, new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  }));
}

async function handle(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const q = url.searchParams;

  // latest-underlying subquery is reused; precompute nothing here (cached on demand).

  if (path === "/api/health") return json(env, { ok: true });
  if (path === "/api/liquidity") return json(env, await liquidity(env));

  // Read-only pass-through to the continuous loader's live /loop state.
  if (path === "/loader/status")
    return json(env, await loaderGet(env, "/loop/status", "loader:status"));
  if (path === "/loader/symbols")
    return json(env, await loaderGet(env, "/loop/symbols" + url.search, "loader:symbols:" + url.search));

  if (path === "/api/stats") return json(env, await stats(env, q.get("liquid_only") === "true"));
  if (path === "/api/runs") return json(env, await runs(env, num(q.get("limit") ?? 5)));
  if (path === "/api/sectors") return json(env, await sectors(env, q.get("liquid_only") === "true"));
  if (path === "/api/symbols")
    return json(env, await symbols(env, q.get("q") ?? undefined, q.get("liquid_only") === "true", num(q.get("limit") ?? 50)));
  if (path === "/api/news")
    return json(env, await news(env, q.get("symbol"), q.get("limit") ? num(q.get("limit")) : NEWS_DEFAULT_LIMIT));
  if (path === "/api/web_search")
    return json(env, await webSearch(env, q.get("q"), q.get("limit") ? num(q.get("limit")) : WEB_SEARCH_DEFAULT_LIMIT));
  if (path === "/api/iv_rank")
    return json(env, await ivRank(env, q.get("symbol"), q.get("days") ? num(q.get("days")) : IV_RANK_DEFAULT_DAYS));
  if (path === "/api/econ_calendar")
    return json(env, await econCalendar(env, q.get("days") ? num(q.get("days")) : ECON_DEFAULT_DAYS));
  if (path === "/api/tables") return json(env, await schemaTables(env, ctx, q.get("force") === "1"));
  if (path === "/api/chat" && req.method === "POST") {
    return cors(env, await copilotChat(req, env, ctx, {
      schema: () => schemaTables(env, ctx, false),
      query: (sql, limit) => runQuery(env, sql, limit),
      persistResult: (chatId, payload) => persistChatResult(env, chatId, payload),
      news: (symbol, limit) => news(env, symbol, limit),
      webSearch: (query, limit) => webSearch(env, query, limit),
      econCalendar: (days) => econCalendar(env, days),
    }));
  }

  if (path === "/api/notebook/premium")
    return json(env, await notebookPremium(env, {
      target_dte: q.get("target_dte") ? num(q.get("target_dte")) : undefined,
      tolerance: q.get("tolerance") ? num(q.get("tolerance")) : undefined,
      moneyness_band: q.get("moneyness_band") ? num(q.get("moneyness_band")) : undefined,
      min_volume: q.get("min_volume") ? num(q.get("min_volume")) : undefined,
      liquid_only: q.get("liquid_only") === "true",
      limit: q.get("limit") ? num(q.get("limit")) : undefined,
    }));

  if (path.startsWith("/api/symbol/")) {
    const sym = decodeURIComponent(path.slice("/api/symbol/".length)).toUpperCase();
    return json(env, await symbolDetail(env, sym));
  }

  if (path === "/api/underlyings")
    return json(env, await underlyings(env, {
      sector: q.get("sector") ?? undefined, q: q.get("q") ?? undefined,
      liquid_only: q.get("liquid_only") === "true",
      limit: num(q.get("limit") ?? 50), offset: num(q.get("offset") ?? 0),
    }));

  if (path === "/api/screen")
    return json(env, await screen(env, {
      symbol: q.get("symbol") ?? undefined, type: q.get("type") ?? undefined, sector: q.get("sector") ?? undefined,
      min_strike: q.get("min_strike") ? num(q.get("min_strike")) : undefined,
      max_strike: q.get("max_strike") ? num(q.get("max_strike")) : undefined,
      min_volume: q.get("min_volume") ? num(q.get("min_volume")) : undefined,
      min_open_interest: q.get("min_open_interest") ? num(q.get("min_open_interest")) : undefined,
      min_iv: q.get("min_iv") ? num(q.get("min_iv")) : undefined,
      max_iv: q.get("max_iv") ? num(q.get("max_iv")) : undefined,
      min_delta: q.get("min_delta") ? num(q.get("min_delta")) : undefined,
      max_delta: q.get("max_delta") ? num(q.get("max_delta")) : undefined,
      in_the_money: q.has("in_the_money") ? q.get("in_the_money") === "true" : undefined,
      expiration_before: q.get("expiration_before") ?? undefined,
      expiration_after: q.get("expiration_after") ?? undefined,
      liquid_only: q.get("liquid_only") !== "false", // default true
      near_spot_strikes: q.has("near_spot_strikes") ? num(q.get("near_spot_strikes")) : 50,
      sort: q.get("sort") ?? undefined, order: q.get("order") ?? undefined,
      limit: num(q.get("limit") ?? 100), offset: num(q.get("offset") ?? 0),
    }));

  if (path === "/api/query" && req.method === "POST") {
    const body = await req.json() as { sql?: string; limit?: number };
    const sql = body.sql ?? "";
    // Private tables (options.chat_history) are admin-only: block any SQL that
    // references them unless the request carries ADMIN_TOKEN.
    if (!adminAuthorized(req, env) && PRIVATE_LAKE_TABLES_RE.test(sql.toLowerCase())) {
      return json(env, { error: "query references a private table" }, 403);
    }
    return json(env, await runQuery(env, sql, body.limit ?? 1000));
  }

  // Copilot chat history: capture (open, best-effort) + admin-only read.
  if (path === "/api/chat/history" && req.method === "POST")
    return await saveChatHistory(env, ctx, req);
  if (path === "/api/chat/result" && req.method === "GET")
    return await getChatResult(env, q.get("chat_id") ?? "");
  if (path === "/api/admin/chat_history" && req.method === "GET") {
    if (!adminAuthorized(req, env)) return json(env, { error: "unauthorized" }, 401);
    return json(env, await adminChatHistory(env, num(q.get("limit") ?? 100), q.get("before")));
  }

  // Copilot chat shares: create (open, user-requested) + public read. The id
  // IS the capability — no auth, and unknown ids 404 identically to expired.
  if (path === "/api/share/chat" && req.method === "POST")
    return await createShare(env, req);
  if (path.startsWith("/api/share/"))
    return await getSharedChat(env, path.slice("/api/share/".length));


  return json(env, { error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") {
      return cors(env, new Response(null, { status: 204 }));
    }
    try {
      return await handle(env, req, ctx);
    } catch (e) {
      return json(env, { error: String(e) }, 500);
    }
  },
};
