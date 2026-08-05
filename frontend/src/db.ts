// DuckDB-WASM singleton: one in-browser DuckDB instance, lazily initialised.
// Serves the screener's Parquet dataset via httpfs range requests (R2 in prod,
// Vite's static server in local dev) and exposes a tiny `query()` helper that
// mirrors Python's `_rows()` — including the Date -> 'YYYY-MM-DD' coercion the
// UI formatting relies on.
//
// All SQL in `server.ts` runs against the `underlyings` / `option_contracts` /
// `download_log` *views* created here, so the server.py SQL strings transfer
// verbatim with no path edits.

import * as duckdb from '@duckdb/duckdb-wasm';
import { Type } from 'apache-arrow';
// Bundle choice: the `eh` (Emscripten ASYNCIFY) build traps with
// `RuntimeError: memory access out of bounds` on Chrome for complex queries —
// ASYNCIFY has a bounded stack and our 3-CTE notebook overflows it (Firefox
// tolerates it more often than Chrome, which is why it only surfaced there).
// The `mvp` build (no ASYNCIFY, no exceptions) sidesteps this entirely and is
// the officially-supported fallback bundle — ideal for a read-only screener.
// The `coi`/pthreads build is more robust still but requires cross-origin
// isolation headers (COOP/COEP) plus CORP on cross-origin R2 parquet, which is
// more than this app needs. If a future query needs async streaming, revisit.
//
// Worker `.js` (~828 kB) is well under the 25 MiB Pages limit, so it stays
// bundled via the `?worker` import below (Vite wraps it into a Worker). Only
// the `.wasm` is fetched remotely (see the `wasmUrl` const below).
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker';

// The DuckDB-WASM `.wasm` (~39.4 MiB) exceeds Cloudflare Pages' 25 MiB
// per-asset limit, so importing it via Vite's `?url` (which hashes + emits
// it into dist/assets/) breaks the Pages deploy:
//   "Pages only supports files up to 25 MiB in size — assets/duckdb-mvp-*.wasm
//    is 39.4 MiB"
// Instead we fetch the wasm by URL from the jsDelivr CDN, which mirrors npm
// 1:1 and serves it with `Access-Control-Allow-Origin: *`,
// `Content-Type: application/wasm`, `Accept-Ranges: bytes`, and a 1-year
// immutable cache — so DuckDB-WASM's instantiate() can stream it over HTTP
// range requests cross-origin. The version here MUST match the
// @duckdb/duckdb-wasm pin in frontend/package.json (currently
// 1.33.1-dev57.0); bump both together on upgrade.
const wasmUrl =
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-mvp.wasm';

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

// Base URL for the Parquet dataset. In local dev this points at Vite's static
// serving of `frontend/public/options/`; in prod it'll be `VITE_R2_BASE`
// (https://...r2.../options). Trailing slash normalised.
const PARQUET_BASE: string =
  (import.meta.env.VITE_R2_BASE as string | undefined)?.replace(/\/$/, '') ??
  `${window.location.origin}${import.meta.env.BASE_URL}options`;

let _db: duckdb.AsyncDuckDB | null = null;
let _conn: duckdb.AsyncDuckDBConnection | null = null;

/**
 * Initialise DuckDB-WASM, load httpfs, and create views over the Parquet files.
 * Idempotent — safe to await from multiple callers.
 */
async function init(): Promise<void> {
  if (_conn) return;
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, new workerUrl());
  await db.instantiate(wasmUrl);
  await db.open({ path: ':memory:' });
  const conn = await db.connect();

  // httpfs is statically linked into the WASM build; just load it so
  // read_parquet() can fetch over HTTP with range requests.
  await conn.query('LOAD httpfs;');

  // Create the views the rest of the app queries. Same names as the DuckDB
  // tables server.py reads, so SQL transfers unchanged.
  const files: Array<[string, string]> = [
    ['underlyings', 'underlyings.parquet'],
    ['option_contracts', 'option_contracts.parquet'],
    ['download_log', 'download_log.parquet'],
  ];
  for (const [view, file] of files) {
    const url = `${PARQUET_BASE}/${file}`;
    await conn.query(
      `CREATE VIEW ${view} AS SELECT * FROM read_parquet('${url}');`,
    );
  }

  _db = db;
  _conn = conn;
}

// Transient errors in this DuckDB-WASM dev build. Complex multi-window
// queries over HTTP parquet occasionally trap the WASM (`RuntimeError:
// ... out of bounds`) or leave a dangling transaction. `memory access out
// of bounds` (the eh-build ASYNCIFY stack overflow on Chrome) is included
// even though we now ship the mvp bundle — kept as defense in case a future
// bundle swap reintroduces it.
const TRANSIENT = /out of bounds|cannot start a transaction|TransactionContext|out of memory/i;

/** Render a JS value as a safe, self-contained SQL literal. We inline params
 * as literals instead of using prepared statements: on this DuckDB-WASM dev
 * build, `conn.prepare()` + `stmt.query(...params)` is markedly flakier than
 * `conn.query(sql)` with inlined literals, and — critically — a prepared
 * statement is invalidated if the shared connection is reset by a *concurrent*
 * query's retry (surfacing as `No prepared statement found with ID`). Inlining
 * removes that whole class of failure: there are no statement handles to
 * invalidate. All params originate in `server.ts` as already-validated
 * numbers, booleans, or UI strings, so the only injection surface is the
 * string-escaping here, which doubles single quotes (standard SQL). */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'bigint') return String(v);
  // string — escape single quotes by doubling them (SQL standard).
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Substitute `?` placeholders in `sql` with inlined literals. Only `?`
 * tokens *outside* single-quoted string literals are replaced, so a literal
 * `'?'` inside the SQL text is left untouched. */
function inlineParams(sql: string, params: unknown[]): string {
  if (!params.length) return sql;
  let out = '';
  let inStr = false;
  let pi = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      // a doubled single quote inside a string literal is an escaped quote,
      // not the end of the string — skip the next quote if it's also `'`.
      if (inStr && sql[i + 1] === "'") { out += "'"; i++; }
      else inStr = !inStr;
      continue;
    }
    if (!inStr && ch === '?') {
      out += pi < params.length ? lit(params[pi++]) : '?';
      continue;
    }
    out += ch;
  }
  return out;
}

async function runOnce(sql: string, params?: unknown[]) {
  const c = _conn!;
  const finalSql = params && params.length ? inlineParams(sql, params) : sql;
  return await c.query(finalSql);
}

// The mvp (non-ASYNCIFY) build cannot run concurrent queries on a single
// connection — overlapping `conn.query()` calls contend inside DuckDB, error
// out, and the no-exceptions build can't propagate the error (surfacing as
// `_setThrew is not defined`). The app fires concurrent queries (stats +
// sectors + screen, each preceded by a liquidUnderlyingSymbols lookup), so we
// serialize ALL queries through one promise chain: only one `runOnce` is ever
// in flight at a time. The dataset is tiny (sub-100ms scans), so the added
// latency is negligible and this keeps the no-header mvp bundle viable (no
// COOP/COEP needed for the R2 step).
let _chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = _chain.then(fn, fn); // run after the previous completes (ok or err)
  _chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

/** Swap to a fresh connection to recover from a WASM trap that left the
 * current connection in a bad state. We DON'T close the old connection
 * synchronously: another in-flight query may still be holding it (queries run
 * concurrently from the UI). Instead we open a new connection and detach the
 * old one for async cleanup, so a concurrent query finishing on the old
 * connection isn't yanked out from under it. */
async function reconnect(): Promise<void> {
  if (!_db) return;
  const stale = _conn;
  try { _conn = await _db.connect(); } catch { /* ignore */ }
  // best-effort close of the stale connection on the next tick
  if (stale) { try { await stale.close(); } catch { /* ignore */ } }
}

/**
 * Run SQL with optional `?` placeholders (same binding style as Python duckdb).
 * Params are inlined as safe literals (see `lit`) — no prepared statements —
 * so a concurrent query's retry/reconnect can't invalidate this query's
 * statement handle. Returns `{columns, rows}` with the same value coercion
 * server.py's `_rows()` performs: temporal columns -> ISO strings, BIGINT ->
 * Number. Transient WASM/transaction hiccups are retried (with a fresh
 * connection on later attempts) so flaky complex queries self-heal.
 */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  await ready;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      // Serialized so concurrent callers don't overlap on the single
      // connection (see `serialized`).
      const table = await serialized(() => runOnce(sql, params));
      return materialize(table);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (!TRANSIENT.test(msg) || attempt === 5) throw e;
      // Exponential backoff: 100, 200, 400, 800, 1600 ms. The WASM trap is
      // intermittent and the connection is often left in a bad state, so
      // always reconnect before retrying.
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      await reconnect();
    }
  }
  throw lastErr;
}

/** Convert an apache-arrow Table to `{columns, rows}` with server.py `_rows()`
 * value coercion: DATE -> 'YYYY-MM-DD', TIMESTAMP -> 'YYYY-MM-DD HH:MM:SS',
 * BIGINT -> Number. */
function materialize(table: { schema: { fields: { name: string; type: { typeId: Type } }[] }; numRows: number; getChild(name: string): { toArray(): unknown[] } | null }): QueryResult {
  const columns = table.schema.fields.map((f) => f.name);
  // Which columns are temporal? DuckDB-WASM returns DATE as a JS Date but
  // TIMESTAMP as a plain epoch-ms number, so we can't rely on `instanceof`
  // alone — drive the coercion off the arrow schema instead.
  const temporalIdx = new Set<number>();
  const timestampIdx = new Set<number>();
  table.schema.fields.forEach((f, i) => {
    const id = f.type.typeId;
    if (id === Type.Date || id === Type.Timestamp) temporalIdx.add(i);
    if (id === Type.Timestamp) timestampIdx.add(i);
  });
  const toMs = (v: unknown): number => {
    if (typeof v === 'bigint') return Number(v) / 1000; // arrow BigInt = microseconds
    if (v instanceof Date) return v.getTime();
    return v as number;
  };
  const toDay = (v: unknown): string => {
    const d = new Date(toMs(v));
    return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  };
  const toTimestamp = (v: unknown): string => {
    const d = new Date(toMs(v));
    return d.toISOString().replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS'
  };
  // Read each column once (arrow vectors) and assemble row objects.
  const colArrays = columns.map((name) => table.getChild(name)?.toArray() ?? []);
  const n = table.numRows;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (let j = 0; j < columns.length; j++) {
      const v = colArrays[j][i];
      if (temporalIdx.has(j)) {
        row[columns[j]] = v == null ? null : timestampIdx.has(j) ? toTimestamp(v) : toDay(v);
      } else if (typeof v === 'bigint') {
        row[columns[j]] = Number(v);
      } else {
        row[columns[j]] = v;
      }
    }
    rows.push(row);
  }
  return { columns, rows };
}

/** Resolves once the DuckDB instance is ready and views are created. */
export const ready: Promise<void> = (async () => {
  try {
    await init();
  } catch (e) {
    console.error('[db] DuckDB-WASM init failed:', e);
    throw e;
  }
})();

// Expose query() on window for in-browser diagnostics in dev only.
// Guarded so it never ships in a production build.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __dbQuery: typeof query }).__dbQuery = query;
}
