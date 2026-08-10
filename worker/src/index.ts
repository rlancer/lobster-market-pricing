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
  // OpenRouter site key (secret) funding free anonymous Copilot chats
  // (/api/free/*). Mirrored into worker/.dev.vars for local `wrangler dev` and
  // set as a Worker secret (+ GitHub secret for redeploys); never sent to the
  // browser. The free proxy forwards with this Bearer and drops any client
  // Authorization header.
  OPEN_ROUTER_KEY: string;
  // Free-chat config: pinned model alias (allowlisted server-side — the only
  // model the free proxy accepts) and the per-chat output-token cap
  // (reasoning tokens count against it on OpenRouter). Both non-secret vars.
  FREE_MODEL?: string;
  FREE_MAX_OUTPUT_TOKENS?: string;
  // Dev/test override: "1" forces the free-chat credit gate closed (402) so
  // the exhausted path can be verified / e2e'd without draining the key.
  FREE_CREDIT_EXHAUSTED?: string;
  // Non-secret base URL of the continuous CBOE loader worker, used by the
  // read-only /loader/* pass-through endpoints. Set as a `var` (not a secret).
  LOADER_BASE_URL?: string;
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

/** Compute the full schema payload straight from the lake (uncached). */
async function loadLakeTables(env: Env): Promise<LakeTable[]> {
  const list = await r2sql(env, "SHOW TABLES IN options");
  return Promise.all(
    list.map(async (t): Promise<LakeTable> => {
      const name = String(t.table_name);
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
  const tableNames = listed.map((t) => String(t.table_name)).sort();
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

interface EconCalendarEvent { date: string; title: string; kind: "macro" | "fed"; }

interface EconCalendarResponse {
  window_days: number;
  as_of: string;
  provider: "fred" | "federalreserve";
  items: EconCalendarEvent[];
  error?: string;
}

// Upcoming FOMC (meetings/statements/minutes/press conferences) + Beige Book
// from the Fed's keyless calendar JSON. Date = `month` + `days`; `days` can be
// a comma list for recurring releases (take the first).
async function fedCalendarEvents(days: number): Promise<EconCalendarEvent[]> {
  const res = await fetch(FED_CALENDAR_URL);
  if (!res.ok) throw new Error(`federalreserve calendar returned HTTP ${res.status}`);
  const data = await res.json() as { events?: { title?: string; type?: string; month?: string; days?: string }[] };
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
    items.push({ date, title: (e.title ?? "").trim() || String(e.type ?? ""), kind: "fed" });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

async function econCalendar(env: Env, daysIn: number): Promise<EconCalendarResponse> {
  const days = clamp(daysIn || ECON_DEFAULT_DAYS, 1, ECON_MAX_DAYS);
  const asOf = () => new Date().toISOString();
  try {
    return await cached<EconCalendarResponse>(`econ:${days}`, ECON_TTL_MS, async () => {
      if (env.FRED_API_KEY) {
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const end = new Date(Date.now() + days * 86400_000);
        const url =
          `${FRED_API_URL}?api_key=${encodeURIComponent(env.FRED_API_KEY)}&file_type=json` +
          `&realtime_start=${iso(new Date())}&realtime_end=${iso(end)}` +
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
// Free anonymous chats — /api/free/*
// ---------------------------------------------------------------------------
// Every visitor can chat in the Copilot for free, funded by the site's own
// OpenRouter key (OPEN_ROUTER_KEY secret). The throttle is the *credit on that
// key*, not a per-user quota: open iff the live balance is positive and the
// key carries purchased credits (!is_free_tier — an unfunded key would serve
// OpenRouter's 50 req/day free tier, not our credit, so it counts as
// exhausted). Balance is read live from /auth/key and cached in-isolate ~60s,
// so the gate is soft (worst-case overshoot between checks is pennies) and
// topping the key back up re-opens free mode with no redeploy. Exhausted ⇒
// 402 { error: { code: "free_credit_exhausted" } }; the browser pivots to the
// BYOK connect gate. No fingerprint, no D1 rows, no per-user counting — the
// OpenRouter dashboard + this quota endpoint are the accounting.
//
// The proxy is a byte-level OpenAI-compatible pass-through (stream: true
// always) so the browser's TanStack AI loop, tool parsing and streaming UI
// work unchanged. The client Authorization header is never read — only
// OPEN_ROUTER_KEY is ever forwarded. The client only ever targets
// FREE_MODEL (allowlisted) and max_tokens is clamped to the per-chat spend
// cap; reasoning tokens count against it on OpenRouter.
const FREE_MODEL_DEFAULT = '~deepseek/deepseek-v4-flash-latest';
const FREE_MAX_OUTPUT_TOKENS_DEFAULT = 4096;
const FREE_QUOTA_TTL_MS = 60 * 1000;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const FREE_QUOTA_KEY = 'free:quota';

function freeModel(env: Env): string {
  return env.FREE_MODEL?.trim() || FREE_MODEL_DEFAULT;
}

function freeMaxOutputTokens(env: Env): number {
  const v = Number(env.FREE_MAX_OUTPUT_TOKENS);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : FREE_MAX_OUTPUT_TOKENS_DEFAULT;
}

interface FreeCredit {
  remaining: number;
  limit: number;
  is_free_tier: boolean;
}

/** Live balance on the site key, cached in-isolate ~60s (only successes cache). */
async function freeCredit(env: Env): Promise<FreeCredit> {
  return cached<FreeCredit>(FREE_QUOTA_KEY, FREE_QUOTA_TTL_MS, async () => {
    const res = await fetch(`${OPENROUTER_API_URL}/auth/key`, {
      headers: { Authorization: `Bearer ${env.OPEN_ROUTER_KEY}` },
    });
    if (!res.ok) throw new Error(`OpenRouter key check failed (${res.status})`);
    const j = (await res.json()) as {
      data?: { usage?: number; limit?: number; limit_remaining?: number; is_free_tier?: boolean };
    };
    const d = j.data ?? {};
    const limit = typeof d.limit === 'number' ? d.limit : -1;
    const remaining =
      typeof d.limit_remaining === 'number'
        ? d.limit_remaining
        : limit >= 0 && typeof d.usage === 'number'
          ? limit - d.usage
          : 0;
    return { remaining, limit, is_free_tier: d.is_free_tier === true };
  });
}

/** True when anonymous chats may run: funded key with positive balance. */
function freeGateOpen(credit: FreeCredit, env: Env): boolean {
  if (env.FREE_CREDIT_EXHAUSTED === '1') return false;
  return credit.remaining > 0 && !credit.is_free_tier;
}

function freeQuotaPayload(env: Env): Promise<{ remaining: number; limit: number; is_free_tier: boolean; model: string }> {
  return freeCredit(env).then((credit) => ({
    remaining: freeGateOpen(credit, env) ? Math.max(0, credit.remaining) : 0,
    limit: credit.limit,
    is_free_tier: credit.is_free_tier,
    model: freeModel(env),
  }));
}

/**
 * POST /api/free/v1/chat/completions — OpenAI-compatible SSE pass-through on
 * the site key. Forces model = FREE_MODEL (allowlist: reject any other),
 * clamps max_tokens to the spend cap, forces stream: true, and never forwards
 * a client Authorization header (the API key field is stripped too). Returns
 * the upstream response through cors(); body untouched.
 */
async function freeChat(env: Env, req: Request): Promise<Response> {
  const credit = await freeCredit(env);
  if (!freeGateOpen(credit, env)) {
    return json(env, { error: { code: 'free_credit_exhausted', remaining: 0 } }, 402);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(env, { error: 'invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(env, { error: 'invalid JSON body' }, 400);
  }

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (requestedModel && requestedModel !== freeModel(env)) {
    return json(env, { error: `model not allowed on the free tier (only ${freeModel(env)})` }, 400);
  }

  const maxTokens = typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
    ? Math.min(Math.max(Math.round(body.max_tokens), 1), freeMaxOutputTokens(env))
    : freeMaxOutputTokens(env);

  // Rebuild the payload: force the pinned model / stream / cap, and drop any
  // client-supplied credentials (api_key, Authorization is never read anyway).
  const payload: Record<string, unknown> = { ...body, model: freeModel(env), max_tokens: maxTokens, stream: true };
  delete payload.api_key;
  delete payload.authorization;

  const upstream = await fetch(`${OPENROUTER_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPEN_ROUTER_KEY}`,
      // OpenRouter attribution (same as the BYOK path): the site is the
      // referer for anonymous visitors.
      'HTTP-Referer': req.headers.get('Origin') ?? 'https://robs-options-slop-dev.pages.dev',
      'X-Title': 'Open Interest Options Workspace',
    },
    body: JSON.stringify(payload),
  });

  // Observability: no user data to redact — model + spend cap + outcome only.
  console.log(JSON.stringify({ freeChat: true, model: freeModel(env), outputTokens: maxTokens, httpStatus: upstream.status }));

  const resp = new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream' },
  });
  return cors(env, resp);
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
  // The OpenAI SDK (free-chat proxy) sends Authorization, HTTP-Referer /
  // X-Title, and a version-dependent X-Stainless-* header set — a fixed list
  // would break whenever the SDK adds one. The worker is already CORS-open
  // (CORS_ORIGIN "*") and ignores client headers, so allow any header (no
  // credentials are ever sent, which is what `*` requires).
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
    return json(env, await runQuery(env, body.sql ?? "", body.limit ?? 1000));
  }

  // Free anonymous chats on the site's OpenRouter credit.
  if (path === "/api/free/quota") return json(env, await freeQuotaPayload(env));
  if (path === "/api/free/v1/chat/completions" && req.method === "POST")
    return await freeChat(env, req);

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
