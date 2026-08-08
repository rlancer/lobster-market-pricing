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
  // Non-secret base URL of the continuous CBOE loader worker, used by the
  // read-only /loader/* pass-through endpoints. Set as a `var` (not a secret).
  LOADER_BASE_URL?: string;
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
const RESULT_TTL_MS = 5 * 60 * 1000; // 5 min — data is nightly-refreshed
const LIQ_TTL_MS = 10 * 60 * 1000;
const R2SQL_LIMIT_MAX = 10000;

interface CacheEntry { ts: number; val: unknown; }
const cache = new Map<string, CacheEntry>();

function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) return Promise.resolve(hit.val as T);
  return compute().then((val) => { cache.set(key, { ts: now, val }); return val; });
}

// ---------------------------------------------------------------------------
// R2 SQL REST client
// ---------------------------------------------------------------------------
function apiUrl(env: Env): string {
  return `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.R2_SQL_ACCOUNT_ID}/r2-sql/query/${env.R2_SQL_BUCKET}`;
}

interface R2Row { [k: string]: unknown; }

async function r2sql(env: Env, sql: string, key?: string): Promise<R2Row[]> {
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
  return key ? cached<R2Row[]>(key, RESULT_TTL_MS, run) : run();
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
  if (!q) {
    const rows = await r2sql(env, `SELECT symbol, name, sector FROM (${LATEST_UNDERLYING}) WHERE true ${filter} ORDER BY symbol LIMIT ${lim}`, "syms_all_" + lim);
    return rows.map(row);
  }
  const u = `%${q.toUpperCase()}%`;
  const rows = await r2sql(env,
    `SELECT symbol, name, sector FROM (${LATEST_UNDERLYING}) ` +
    `WHERE (UPPER(symbol) LIKE ${lit(u)} OR UPPER(COALESCE(name,'')) LIKE ${lit(u)}) ${filter} ` +
    `ORDER BY CASE WHEN UPPER(symbol) = ${lit(q.toUpperCase())} THEN 0 WHEN UPPER(symbol) LIKE ${lit(q.toUpperCase() + "%")} THEN 1 ELSE 2 END, symbol LIMIT ${lim}`);
  return rows.map(row);
}
function row(r: R2Row): { symbol: string; name: string | null; sector: string | null } {
  return { symbol: String(r.symbol), name: strOrNull(r.name), sector: strOrNull(r.sector) };
}

async function symbolDetail(env: Env, symbol: string): Promise<{
  underlying: { symbol: string; name: string | null; sector: string | null; spot: number | null; fetched_at: string | null } | null;
  contracts: Row[]; expirations: string[]; n_contracts: number; liquid: boolean;
}> {
  const u = await r2sql(env, `SELECT symbol, name, sector, spot_price, run_id, fetched_at FROM (${LATEST_UNDERLYING}) WHERE symbol = ${lit(symbol)}`);
  if (!u.length) return { underlying: null, contracts: [], expirations: [], n_contracts: 0, liquid: false };
  const ud = u[0];
  // contracts for the latest run of this symbol
  const rows = await r2sql(env,
    `SELECT expiration, type, strike, last, bid, ask, volume, open_interest, implied_vol, ` +
    `delta, gamma, theta, vega, rho, in_the_money, theo, bid_size, ask_size, fetched_at ` +
    `FROM options.option_contracts WHERE symbol = ${lit(symbol)} ` +
    `AND run_id = ${lit(ud.run_id)} ORDER BY expiration, strike, type LIMIT ${R2SQL_LIMIT_MAX}`);
  const expirations = sortedUnique(rows.map((r) => String(r.expiration)));
  const syms = await liquidSymbols(env);
  return {
    underlying: {
      symbol: String(ud.symbol), name: strOrNull(ud.name), sector: strOrNull(ud.sector),
      spot: numOrNull(ud.spot_price), fetched_at: strOrNull(ud.fetched_at),
    },
    contracts: rows as Row[],
    expirations,
    n_contracts: rows.length,
    liquid: syms.includes(symbol),
  };
}

async function tables(env: Env): Promise<{ name: string; row_count: number | null; columns: { name: string; type: string }[] }[]> {
  const list = await r2sql(env, "SHOW TABLES IN options");
  const out: { name: string; row_count: number | null; columns: { name: string; type: string }[] }[] = [];
  for (const t of list) {
    const name = String(t.table_name);
    const [cols, cnt] = await Promise.all([
      r2sql(env, `DESCRIBE options.${name}`),
      r2sql(env, `SELECT COUNT(*) n FROM options.${name}`, "tbl_count_" + name),
    ]);
    out.push({
      name,
      row_count: num(cnt[0]?.n),
      columns: cols.map((c) => ({ name: String(c.column_name), type: String(c.type) })),
    });
  }
  return out;
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
    const rows = await r2sql(env, `SELECT * FROM (${cleaned}) AS __q LIMIT ${lim}`);
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
  const rows = (await r2sql(env, sql)) as Row[];
  return {
    notebook: "45-day-premium-leaders", target_dte: targetDte, tolerance: tol,
    moneyness_band: band, min_volume: minVol,
    calls: rows.filter((r) => r.type === "call"), puts: rows.filter((r) => r.type === "put"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function numOrNull(v: unknown): number | null { const n = Number(v); return v == null || !Number.isFinite(n) ? null : n; }
function strOrNull(v: unknown): string | null { return v == null ? null : String(v); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n))); }
function sortedUnique(arr: string[]): string[] { return Array.from(new Set(arr)).sort(); }

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
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}

function json(env: Env, data: unknown, status = 200): Response {
  return cors(env, new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  }));
}

async function handle(env: Env, req: Request): Promise<Response> {
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
  if (path === "/api/tables") return json(env, await tables(env));
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

  return json(env, { error: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") {
      return cors(env, new Response(null, { status: 204 }));
    }
    try {
      return await handle(env, req);
    } catch (e) {
      return json(env, { error: String(e) }, 500);
    }
  },
};
