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
import workerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?worker';
import wasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';

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

// Errors considered transient in this DuckDB-WASM dev build (complex
// multi-window queries over HTTP parquet occasionally trap the WASM with
// `RuntimeError: index out of bounds`, sometimes leaving a dangling
// transaction). Retrying (and on later attempts re-opening the connection)
// reliably recovers — the same query succeeds on the next attempt.
// Transient WASM/transaction hiccups in this dev build. Note `memory access
// out of bounds` (the eh-build ASYNCIFY stack overflow on Chrome) is included
// even though we now ship the mvp bundle — kept as defense in case a future
// bundle swap reintroduces it.
const TRANSIENT = /out of bounds|cannot start a transaction|TransactionContext|out of memory/i;

async function runOnce(sql: string, params?: unknown[]) {
  const c = _conn!;
  if (params && params.length) {
    const stmt = await c.prepare(sql);
    try {
      return await stmt.query(...params);
    } finally {
      await stmt.close();
    }
  }
  return await c.query(sql);
}

/** Reopen the connection (used to recover from WASM traps that leave the
 * current connection in a bad state). */
async function reconnect(): Promise<void> {
  if (!_db) return;
  try { await _conn?.close(); } catch { /* ignore */ }
  try { _conn = await _db.connect(); } catch { /* ignore */ }
}

/**
 * Run SQL with optional `?` placeholders (same binding style as Python duckdb).
 * Returns `{columns, rows}` with the same value coercion server.py's `_rows()`
 * performs: temporal columns -> ISO strings, BIGINT -> Number. Transient
 * WASM/transaction hiccups are retried (with a connection reset on later
 * attempts) so flaky complex queries self-heal.
 */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  await ready;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const table = await runOnce(sql, params);
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
