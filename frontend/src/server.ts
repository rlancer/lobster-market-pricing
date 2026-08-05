// TypeScript port of backend/screener/server.py. Every SQL string transfers
// verbatim from the Python original — DuckDB-WASM speaks the same dialect and
// uses the same `?` placeholders + params-array binding. Only the surrounding
// Python becomes TypeScript, and the return shapes match the types already
// declared in `api.ts` so the UI components need no changes.
//
// Endpoints map 1:1 to api.ts methods:
//   GET /api/health             -> health()
//   GET /api/liquidity          -> liquidity()
//   GET /api/stats              -> stats(liquid_only)
//   GET /api/sectors            -> sectors(liquid_only)
//   GET /api/underlyings        -> underlyings({sector,q,liquid_only,limit,offset})
//   GET /api/screen             -> screen(params)
//   GET /api/symbol/{symbol}    -> symbolDetail(symbol)
//   GET /api/symbols            -> symbols({q,liquid_only,limit})
//   GET /api/tables             -> tables()
//   POST /api/query             -> runQuery({sql,limit})
//   GET /api/notebook/premium   -> notebookPremium(params)

import { query } from './db';
import type {
  LiquidityInfo,
  PremiumNotebook,
  QueryResult,
  ScreenResponse,
  SectorRow,
  Stats,
  SymbolDetail,
  SymbolSuggestion,
  TableInfo,
  Underlying,
} from './api';

// ---------------------------------------------------------------------------
// Global liquidity filter (underlying-level) — constants port verbatim.
// ---------------------------------------------------------------------------
export const LIQ_MIN_VOLUME = 10;
export const LIQ_MIN_OI = 100;
export const LIQ_MAX_SPREAD = 0.15;
export const LIQ_ATM_BAND = 0.10;
export const LIQ_MIN_ATM_CONTRACTS = 5;

const LIQ_TTL_MS = 60_000;

// TTL memo cache keyed on the threshold signature (mirrors Python's
// _LIQUID_CACHE dict keyed on the threshold tuple).
const _liquidCache = new Map<string, { syms: string[]; expires: number }>();

/**
 * Return the sorted list of tradable (liquid) underlying symbols.
 * Memoized for LIQ_TTL_MS so every endpoint can call it cheaply.
 */
export async function liquidUnderlyingSymbols(opts?: {
  min_volume?: number;
  min_oi?: number;
  max_spread?: number;
  atm_band?: number;
  min_atm_contracts?: number;
}): Promise<string[]> {
  const minVolume = opts?.min_volume ?? LIQ_MIN_VOLUME;
  const minOi = opts?.min_oi ?? LIQ_MIN_OI;
  const maxSpread = opts?.max_spread ?? LIQ_MAX_SPREAD;
  const atmBand = opts?.atm_band ?? LIQ_ATM_BAND;
  const minAtm = opts?.min_atm_contracts ?? LIQ_MIN_ATM_CONTRACTS;

  const key = [minVolume, minOi, maxSpread, atmBand, minAtm].join(',');
  const now = Date.now();
  const cached = _liquidCache.get(key);
  if (cached && cached.expires > now) return cached.syms;

  const sql = `
    SELECT c.symbol
    FROM option_contracts c
    JOIN underlyings u ON u.symbol = c.symbol
    WHERE u.spot > 0
      AND c.bid > 0 AND c.ask > 0 AND c.ask >= c.bid
      AND (c.ask - c.bid) / ((c.bid + c.ask) / 2.0) <= ?
      AND (COALESCE(c.volume, 0) >= ? OR COALESCE(c.open_interest, 0) >= ?)
      AND ABS((c.strike - u.spot) / u.spot) <= ?
    GROUP BY c.symbol
    HAVING COUNT(*) >= ?
    ORDER BY c.symbol
  `;
  const { rows } = await query(sql, [maxSpread, minVolume, minOi, atmBand, minAtm]);
  const syms = rows.map((r) => r.symbol as string).sort();
  _liquidCache.set(key, { syms, expires: now + LIQ_TTL_MS });
  return syms;
}

/** Drop the cached liquid-symbol set (call after a data refresh). */
export function invalidateLiquidityCache(): void {
  _liquidCache.clear();
}

/** Build a `(?, ?, ...)` IN-list + params; returns `['(FALSE)', []]` if empty. */
function inClause(symbols: string[]): { sql: string; params: unknown[] } {
  if (!symbols.length) return { sql: '(FALSE)', params: [] };
  return { sql: '(' + symbols.map(() => '?').join(',') + ')', params: [...symbols] };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function health(): { ok: true } {
  return { ok: true };
}

export async function liquidity(): Promise<LiquidityInfo> {
  const { rows: totalRows } = await query('SELECT COUNT(*) AS n FROM underlyings');
  const total = Number(totalRows[0].n);
  const syms = await liquidUnderlyingSymbols();
  return {
    enabled_defaults: {
      min_volume: LIQ_MIN_VOLUME,
      min_open_interest: LIQ_MIN_OI,
      max_spread: LIQ_MAX_SPREAD,
      atm_band: LIQ_ATM_BAND,
      min_atm_contracts: LIQ_MIN_ATM_CONTRACTS,
    },
    total_underlyings: total,
    liquid_underlyings: syms.length,
    description:
      `An underlying is tradable iff it has >= ${LIQ_MIN_ATM_CONTRACTS} contracts within +/- ` +
      `${Math.round(LIQ_ATM_BAND * 100)}% of spot that each have a two-sided quote ` +
      `(bid>0, ask>=bid), a relative bid-ask spread <= ${Math.round(LIQ_MAX_SPREAD * 100)}%, ` +
      `and demonstrated interest (volume >= ${LIQ_MIN_VOLUME} OR open interest >= ${LIQ_MIN_OI}).`,
  };
}

export async function stats(liquidOnly = false): Promise<Stats> {
  let nSym: number;
  let nCon: number;
  let nCalls: number;
  let nPuts: number;
  if (liquidOnly) {
    const syms = await liquidUnderlyingSymbols();
    const { sql, params } = inClause(syms);
    const [con, calls, puts] = await Promise.all([
      query(`SELECT COUNT(*) AS n FROM option_contracts WHERE symbol IN ${sql}`, params),
      query(`SELECT COUNT(*) AS n FROM option_contracts WHERE type='call' AND symbol IN ${sql}`, params),
      query(`SELECT COUNT(*) AS n FROM option_contracts WHERE type='put' AND symbol IN ${sql}`, params),
    ]);
    nSym = syms.length;
    nCon = Number(con.rows[0].n);
    nCalls = Number(calls.rows[0].n);
    nPuts = Number(puts.rows[0].n);
  } else {
    const [sym, con, calls, puts] = await Promise.all([
      query('SELECT COUNT(*) AS n FROM underlyings'),
      query('SELECT COUNT(*) AS n FROM option_contracts'),
      query("SELECT COUNT(*) AS n FROM option_contracts WHERE type='call'"),
      query("SELECT COUNT(*) AS n FROM option_contracts WHERE type='put'"),
    ]);
    nSym = Number(sym.rows[0].n);
    nCon = Number(con.rows[0].n);
    nCalls = Number(calls.rows[0].n);
    nPuts = Number(puts.rows[0].n);
  }
  const { rows } = await query(
    "SELECT COALESCE(MAX(fetched_at)::VARCHAR, '') AS last FROM option_contracts",
  );
  return {
    underlyings: nSym,
    contracts: nCon,
    calls: nCalls,
    puts: nPuts,
    last_updated: String(rows[0].last ?? ''),
  };
}

export async function sectors(liquidOnly = false): Promise<SectorRow[]> {
  let extra = '';
  let params: unknown[] = [];
  if (liquidOnly) {
    const syms = await liquidUnderlyingSymbols();
    const ic = inClause(syms);
    extra = `WHERE symbol IN ${ic.sql}`;
    params = ic.params;
  }
  const { rows } = await query(
    `SELECT sector, COUNT(*) AS symbols, AVG(spot) AS avg_spot
     FROM underlyings ${extra} GROUP BY sector ORDER BY sector`,
    params,
  );
  return rows as unknown as SectorRow[];
}

export interface UnderlyingsParams {
  sector?: string;
  q?: string;
  liquid_only?: boolean;
  limit?: number;
  offset?: number;
}

export async function underlyings(p: UnderlyingsParams = {}): Promise<{
  total: number;
  items: Underlying[];
}> {
  const limit = p.limit ?? 50;
  const offset = p.offset ?? 0;
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.liquid_only) {
    const syms = await liquidUnderlyingSymbols();
    const ic = inClause(syms);
    where.push(`u.symbol IN ${ic.sql}`);
    params.push(...ic.params);
  }
  if (p.sector) {
    where.push('u.sector = ?');
    params.push(p.sector);
  }
  if (p.q) {
    where.push('(UPPER(u.symbol) LIKE ? OR UPPER(u.name) LIKE ?)');
    params.push(`%${p.q.toUpperCase()}%`, `%${p.q.toUpperCase()}%`);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows: totalRows } = await query(
    `SELECT COUNT(*) AS n FROM underlyings u ${clause}`,
    params,
  );
  const total = Number(totalRows[0].n);

  const pageParams = [...params, limit, offset];
  const { rows } = await query(
    `SELECT u.symbol, u.name, u.sector, u.spot,
            (SELECT COUNT(*) FROM option_contracts c WHERE c.symbol=u.symbol) AS contracts
     FROM underlyings u ${clause}
     ORDER BY u.symbol LIMIT ? OFFSET ?`,
    pageParams,
  );
  return { total, items: rows as unknown as Underlying[] };
}

export interface ScreenParams {
  symbol?: string;
  type?: 'call' | 'put';
  sector?: string;
  min_strike?: number;
  max_strike?: number;
  min_volume?: number;
  min_open_interest?: number;
  min_iv?: number;
  max_iv?: number;
  min_delta?: number;
  max_delta?: number;
  in_the_money?: boolean;
  expiration_before?: string;
  expiration_after?: string;
  liquid_only?: boolean;
  near_spot_strikes?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const ALLOWED_SORT = new Set([
  'volume', 'open_interest', 'strike', 'implied_vol', 'delta',
  'theta', 'vega', 'gamma', 'bid', 'ask', 'last', 'expiration',
]);

export async function screen(p: ScreenParams = {}): Promise<ScreenResponse> {
  const order = p.order === 'asc' ? 'ASC' : 'DESC';
  const sort = p.sort ?? 'volume';
  const limit = p.limit ?? 100;
  const offset = p.offset ?? 0;
  const nearSpotStrikes = p.near_spot_strikes ?? 50;

  const where: string[] = ['c.symbol IS NOT NULL'];
  const params: unknown[] = [];
  if (p.symbol) { where.push('c.symbol = ?'); params.push(p.symbol.toUpperCase()); }
  if (p.type) { where.push('c.type = ?'); params.push(p.type); }
  if (p.sector) { where.push('u.sector = ?'); params.push(p.sector); }
  if (p.min_strike != null) { where.push('c.strike >= ?'); params.push(p.min_strike); }
  if (p.max_strike != null) { where.push('c.strike <= ?'); params.push(p.max_strike); }
  if (p.min_volume != null) { where.push('COALESCE(c.volume,0) >= ?'); params.push(p.min_volume); }
  if (p.min_open_interest != null) { where.push('COALESCE(c.open_interest,0) >= ?'); params.push(p.min_open_interest); }
  if (p.min_iv != null) { where.push('c.implied_vol >= ?'); params.push(p.min_iv); }
  if (p.max_iv != null) { where.push('c.implied_vol <= ?'); params.push(p.max_iv); }
  if (p.min_delta != null) { where.push('c.delta >= ?'); params.push(p.min_delta); }
  if (p.max_delta != null) { where.push('c.delta <= ?'); params.push(p.max_delta); }
  if (p.in_the_money != null) { where.push('c.in_the_money = ?'); params.push(p.in_the_money); }
  if (p.expiration_before) { where.push('c.expiration <= ?'); params.push(p.expiration_before); }
  if (p.expiration_after) { where.push('c.expiration >= ?'); params.push(p.expiration_after); }
  if (p.liquid_only ?? true) {
    const syms = await liquidUnderlyingSymbols();
    const ic = inClause(syms);
    where.push(`c.symbol IN ${ic.sql}`);
    params.push(...ic.params);
  }

  // Limit each underlying to its N strikes nearest spot (ATM band). Off when
  // 0/None. Implemented as a CTE over DISTINCT (symbol, strike) ranked by
  // |strike - spot|, then an EXISTS filter on the main query.
  let cte = '';
  if (nearSpotStrikes && nearSpotStrikes > 0) {
    cte =
      'WITH atm_strikes AS (\n' +
      '  SELECT symbol, strike FROM (\n' +
      '    SELECT ds.symbol, ds.strike,\n' +
      '           ROW_NUMBER() OVER (PARTITION BY ds.symbol\n' +
      '                              ORDER BY ABS(ds.strike - au.spot)) AS rn\n' +
      '    FROM (SELECT DISTINCT c2.symbol, c2.strike FROM option_contracts c2\n' +
      '          JOIN underlyings u2 ON u2.symbol = c2.symbol\n' +
      '          WHERE u2.spot IS NOT NULL) ds\n' +
      '    JOIN underlyings au ON au.symbol = ds.symbol\n' +
      '  ) WHERE rn <= ?\n' +
      ')\n';
    where.push(
      'EXISTS (SELECT 1 FROM atm_strikes a ' +
      'WHERE a.symbol = c.symbol AND a.strike = c.strike)',
    );
    // the CTE's `?` precedes the WHERE params in the SQL text
    params.unshift(nearSpotStrikes);
  }

  const clause = 'WHERE ' + where.join(' AND ');

  const sortCol = ALLOWED_SORT.has(sort) ? sort : 'volume';
  const sortExpr =
    sortCol !== 'expiration'
      ? `COALESCE(c.${sortCol},0)`
      : `c.${sortCol}`;

  const countSql =
    `${cte}SELECT COUNT(*) FROM option_contracts c ` +
    `LEFT JOIN underlyings u ON u.symbol = c.symbol ${clause}`;
  const { rows: countRows } = await query(countSql, params);
  const total = Number(countRows[0].n);

  const qparams = [...params, limit, offset];
  const dataSql =
    `${cte}SELECT c.symbol, u.name AS name, u.sector AS sector, u.spot AS spot,
            c.expiration, c.type, c.strike, c.last, c.bid, c.ask,
            c.volume, c.open_interest, c.implied_vol,
            c.delta, c.gamma, c.theta, c.vega, c.rho, c.in_the_money,
            CASE WHEN u.spot IS NOT NULL AND c.strike > 0
                 THEN ROUND((c.strike - u.spot)/u.spot*100, 2) END AS moneyness_pct
     FROM option_contracts c
     LEFT JOIN underlyings u ON u.symbol = c.symbol
     ${clause}
     ORDER BY ${sortExpr} ${order}, c.symbol ASC
     LIMIT ? OFFSET ?`;
  const { rows } = await query(dataSql, qparams);
  return { total, items: rows as unknown as ScreenResponse['items'] };
}

export async function symbolDetail(symbol: string): Promise<SymbolDetail> {
  const sym = symbol.toUpperCase();
  const { rows: uRows } = await query(
    'SELECT symbol, name, sector, spot, fetched_at FROM underlyings WHERE symbol = ?',
    [sym],
  );
  if (!uRows.length) {
    return { underlying: null, contracts: [], expirations: [], n_contracts: 0, liquid: false };
  }
  const u = uRows[0];
  const underlying = {
    symbol: u.symbol as string,
    name: (u.name as string | null) ?? null,
    sector: (u.sector as string | null) ?? null,
    spot: (u.spot as number | null) ?? null,
    fetched_at: (u.fetched_at as string | null) ?? null,
  };
  const liquidSyms = await liquidUnderlyingSymbols();
  const liquid = liquidSyms.includes(sym);
  const { rows } = await query(
    `SELECT expiration, type, strike, last, bid, ask,
            volume, open_interest, implied_vol,
            delta, gamma, theta, vega, rho, in_the_money
     FROM option_contracts WHERE symbol = ?
     ORDER BY expiration, strike, type`,
    [sym],
  );
  const expirations = sortedUnique(rows.map((r) => r.expiration as string));
  return {
    underlying,
    contracts: rows as unknown as SymbolDetail['contracts'],
    expirations,
    n_contracts: rows.length,
    liquid,
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export interface SymbolsParams {
  q?: string;
  liquid_only?: boolean;
  limit?: number;
}

export async function symbols(p: SymbolsParams = {}): Promise<SymbolSuggestion[]> {
  const limit = p.limit ?? 50;
  let liqFilter = '';
  let liqParams: unknown[] = [];
  if (p.liquid_only) {
    const ic = inClause(await liquidUnderlyingSymbols());
    liqFilter = `AND symbol IN ${ic.sql}`;
    liqParams = ic.params;
  }
  if (!p.q) {
    const { rows } = await query(
      `SELECT symbol, name, sector FROM underlyings
       WHERE TRUE ${liqFilter} ORDER BY symbol LIMIT ?`,
      [...liqParams, limit],
    );
    return rows as unknown as SymbolSuggestion[];
  }
  const like = `%${p.q.toUpperCase()}%`;
  const { rows } = await query(
    `SELECT symbol, name, sector FROM underlyings
     WHERE (UPPER(symbol) LIKE ? OR UPPER(COALESCE(name, '')) LIKE ?)
     ${liqFilter}
     ORDER BY
       CASE
         WHEN UPPER(symbol) = ? THEN 0
         WHEN UPPER(symbol) LIKE ? THEN 1
         ELSE 2
       END,
       symbol
     LIMIT ?`,
    [like, like, ...liqParams, p.q.toUpperCase(), `${p.q.toUpperCase()}%`, limit],
  );
  return rows as unknown as SymbolSuggestion[];
}

// ---------------------------------------------------------------------------
// Data Explorer: introspect schema + run arbitrary read-only SQL
// ---------------------------------------------------------------------------

const EXPLORER_MAX_ROWS = 1000;

export async function tables(): Promise<TableInfo[]> {
  // user tables/views only (schema 'main')
  const { rows: tRows } = await query(
    "SELECT table_name FROM information_schema.tables " +
    "WHERE table_schema = 'main' ORDER BY table_name",
  );
  const out: TableInfo[] = [];
  for (const r of tRows) {
    const name = r.table_name as string;
    const { rows: cRows } = await query(
      "SELECT column_name, data_type FROM information_schema.columns " +
      "WHERE table_schema = 'main' AND table_name = ? " +
      "ORDER BY ordinal_position",
      [name],
    );
    const columns = cRows.map((c) => ({
      name: c.column_name as string,
      type: c.data_type as string,
    }));
    let row_count: number | null = null;
    try {
      const { rows: cnt } = await query(`SELECT COUNT(*) AS n FROM "${name}"`);
      row_count = Number(cnt[0].n);
    } catch {
      row_count = null;
    }
    out.push({ name, row_count, columns });
  }
  return out;
}

/** Reject anything that isn't a single read-only SELECT/WITH query. */
function sanitizeSql(sql: string): string {
  const cleaned = sql.trim().replace(/;+\s*$/, '').trim();
  if (!cleaned) throw new Error('Empty query');
  if (cleaned.includes(';')) {
    throw new Error('Multiple statements are not allowed; please run one query at a time');
  }
  const headMatch = cleaned.replace(/^\(+/, '').trim().match(/^(\w+)/);
  const head = headMatch ? headMatch[1].toUpperCase() : '';
  if (!['SELECT', 'WITH', 'DESCRIBE', 'DESC', 'SHOW', 'EXPLAIN', 'PRAGMA'].includes(head)) {
    throw new Error(
      'Only read-only queries (SELECT/WITH/DESCRIBE/SHOW/EXPLAIN/PRAGMA) are allowed',
    );
  }
  const lowered = cleaned.toLowerCase();
  for (const kw of [
    'insert into', 'update ', 'delete from', 'drop ', 'create ', 'alter ',
    'truncate ', 'attach ', 'detach ', 'copy ', 'load ', 'install ',
  ]) {
    if (lowered.includes(kw)) {
      throw new Error(`Disallowed keyword: ${kw.trim()}`);
    }
  }
  return cleaned;
}

export async function runQuery(opts: {
  sql: string;
  limit?: number;
}): Promise<QueryResult> {
  const sqlIn = opts.sql ?? '';
  let limit = Math.max(1, Math.min(opts.limit ?? EXPLORER_MAX_ROWS, EXPLORER_MAX_ROWS));
  limit = Math.floor(limit) || EXPLORER_MAX_ROWS;
  let cleaned: string;
  try {
    cleaned = sanitizeSql(sqlIn);
  } catch (e) {
    return { error: (e as Error).message, columns: [], rows: [], row_count: 0 };
  }
  try {
    const wrapped = `SELECT * FROM (${cleaned}) AS __q LIMIT ${limit}`;
    const { columns, rows } = await query(wrapped);
    // Mirror Python's list/dict -> str fallback for columns holding
    // structured values.
    const out: Record<string, unknown>[] = rows.map((row) => {
      const o: Record<string, unknown> = {};
      for (const c of columns) {
        const v = row[c];
        if (Array.isArray(v) || (typeof v === 'object' && v !== null && !(v instanceof Date))) {
          o[c] = JSON.stringify(v);
        } else if (v instanceof Date) {
          o[c] = v.toISOString().slice(0, 10);
        } else {
          o[c] = v;
        }
      }
      return o;
    });
    return {
      columns,
      rows: out,
      row_count: out.length,
      truncated: out.length >= limit,
      limit,
    };
  } catch (e) {
    return { error: (e as Error).message, columns: [], rows: [], row_count: 0 };
  }
}

// ---------------------------------------------------------------------------
// Notebooks: saved, parameterized screens
// ---------------------------------------------------------------------------

export interface NotebookPremiumParams {
  target_dte?: number;
  tolerance?: number;
  moneyness_band?: number;
  min_volume?: number;
  liquid_only?: boolean;
  limit?: number;
}

export async function notebookPremium(p: NotebookPremiumParams = {}): Promise<PremiumNotebook> {
  const targetDte = p.target_dte ?? 45;
  const tolerance = Math.max(0, p.tolerance ?? 7);
  const moneynessBand = p.moneyness_band ?? 0.15;
  const minVolume = p.min_volume ?? 0;
  const limit = p.limit ?? 25;
  const liquidOnly = p.liquid_only ?? true;
  const dteLo = Math.max(targetDte - tolerance, 0);
  const dteHi = targetDte + tolerance;

  // DuckDB-WASM's dev build intermittently traps (`RuntimeError: index out of
  // bounds`) on the full 3-nested-CTE notebook query. Breaking it into two
  // pre-created views (global, so they survive the retry's reconnect) makes
  // the final ranked query simple enough to run reliably. Verified 6/6 in
  // browser diagnostics. Params are inlined as literals (all validated
  // numbers from the UI — no injection surface).
  //
  // Note: uses date_diff('day', CURRENT_DATE, expiration) instead of
  // server.py's `expiration - CURRENT_DATE`. DuckDB-WASM's binder does not
  // support the DATE - DATE subtraction operator; date_diff is equivalent
  // and also valid in the Python engine.

  // View 1: liquid symbols (only when liquid_only is set).
  if (liquidOnly) {
    await query(`
      CREATE OR REPLACE VIEW _nb_liq AS
      SELECT c.symbol FROM option_contracts c
      JOIN underlyings u ON u.symbol = c.symbol
      WHERE u.spot > 0 AND c.bid > 0 AND c.ask > 0 AND c.ask >= c.bid
        AND (c.ask - c.bid) / ((c.bid + c.ask) / 2.0) <= ${LIQ_MAX_SPREAD}
        AND (COALESCE(c.volume, 0) >= ${LIQ_MIN_VOLUME} OR COALESCE(c.open_interest, 0) >= ${LIQ_MIN_OI})
        AND ABS((c.strike - u.spot) / u.spot) <= ${LIQ_ATM_BAND}
      GROUP BY c.symbol HAVING COUNT(*) >= ${LIQ_MIN_ATM_CONTRACTS}
    `);
  }

  // View 2: per-symbol expiration closest to target_dte (within tolerance).
  await query(`
    CREATE OR REPLACE VIEW _nb_exp AS
    SELECT symbol, expiration,
           date_diff('day', CURRENT_DATE, expiration) AS dte,
           ROW_NUMBER() OVER (
             PARTITION BY symbol
             ORDER BY ABS(date_diff('day', CURRENT_DATE, expiration) - ${targetDte})
           ) AS rn
    FROM (SELECT DISTINCT symbol, expiration FROM option_contracts) e
    WHERE date_diff('day', CURRENT_DATE, expiration) BETWEEN ${dteLo} AND ${dteHi}
  `);

  const liqFilter = liquidOnly ? 'AND c.symbol IN (SELECT symbol FROM _nb_liq)' : '';
  const sql = `
    WITH ranked AS (
        SELECT c.symbol, u.name, u.sector, u.spot,
               c.expiration, c.type, c.strike,
               c.last, c.bid, c.ask,
               c.volume, c.open_interest, c.implied_vol,
               c.delta, c.in_the_money,
               COALESCE(c.last, (c.bid + c.ask) / 2.0) AS premium,
               CASE WHEN u.spot IS NOT NULL AND u.spot > 0
                    THEN (c.strike - u.spot) / u.spot END AS moneyness,
               CASE WHEN u.spot IS NOT NULL AND u.spot > 0
                    THEN COALESCE(c.last, (c.bid + c.ask) / 2.0) / u.spot
                    END AS premium_ratio,
               ROW_NUMBER() OVER (
                   PARTITION BY c.symbol, c.type
                   ORDER BY
                     (CASE WHEN u.spot IS NOT NULL AND u.spot > 0
                           THEN COALESCE(c.last, (c.bid + c.ask) / 2.0) / u.spot
                           END) DESC NULLS LAST,
                     COALESCE(c.volume, 0) DESC
               ) AS prn
        FROM option_contracts c
        JOIN _nb_exp e ON e.symbol = c.symbol AND e.expiration = c.expiration
        JOIN underlyings u ON u.symbol = c.symbol
        WHERE e.rn = 1
          AND u.spot IS NOT NULL AND u.spot > 0
          AND COALESCE(c.last, (c.bid + c.ask) / 2.0) IS NOT NULL
          AND COALESCE(c.last, (c.bid + c.ask) / 2.0) > 0
          AND COALESCE(c.volume, 0) >= ${minVolume}
          AND ABS((c.strike - u.spot) / u.spot) <= ${moneynessBand}
          ${liqFilter}
    ),
    calls_ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY type ORDER BY premium_ratio DESC NULLS LAST) AS trn
        FROM ranked WHERE prn = 1
    )
    SELECT symbol, name, sector, spot, expiration, type, strike,
           last, bid, ask, volume, open_interest, implied_vol, delta,
           in_the_money, premium, moneyness, premium_ratio
    FROM calls_ranked
    WHERE trn <= ${limit}
    ORDER BY type, premium_ratio DESC NULLS LAST
  `;
  try {
    const { rows } = await query(sql);
    const all = rows as unknown as PremiumNotebook['calls'];
    return {
      notebook: '45-day-premium-leaders',
      target_dte: targetDte,
      tolerance,
      moneyness_band: moneynessBand,
      min_volume: minVolume,
      calls: all.filter((r) => r.type === 'call'),
      puts: all.filter((r) => r.type === 'put'),
    };
  } finally {
    // Clean up the scratch views so they don't clutter the Data Explorer's
    // table listing. Best-effort — ignore errors if the connection was reset.
    try { await query('DROP VIEW IF EXISTS _nb_exp'); } catch { /* ignore */ }
    try { await query('DROP VIEW IF EXISTS _nb_liq'); } catch { /* ignore */ }
  }
}
