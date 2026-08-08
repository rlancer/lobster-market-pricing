import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import './Explorer.css';
import { api, type QueryResult, type TableInfo } from './api';

// Row cap for the auto-`SELECT *` preview fired by clicking a table in the
// schema sidebar. A bounded preview keeps rendering light on huge tables.
const TABLE_PREVIEW_LIMIT = 250;

const SAMPLES = [
  'SELECT ticker AS symbol, name, sector, spot_price FROM options.underlying_snapshots LIMIT 50',
  'SELECT symbol, COUNT(*) AS contracts, MAX(expiration) AS latest_expiry\nFROM options.option_contracts\nGROUP BY 1\nORDER BY contracts DESC\nLIMIT 20',
  'SELECT sector, COUNT(*) AS symbols, ROUND(AVG(spot_price), 2) AS avg_spot\nFROM options.underlying_snapshots\nGROUP BY sector\nORDER BY symbols DESC',
  'SELECT type, COUNT(*) AS n, ROUND(AVG(implied_vol), 4) AS avg_iv,\n         ROUND(AVG(volume), 0) AS avg_vol\nFROM options.option_contracts\nGROUP BY type',
  'SELECT symbol, expiration, type, strike, bid, ask, volume, implied_vol, delta\nFROM options.option_contracts\nWHERE volume > 0\nORDER BY volume DESC\nLIMIT 100',
];

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(v);
}

function Explorer() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const { sql: initialSql } = useSearch({ strict: false }) as { sql?: string };
  const [sql, setSql] = useState(initialSql ?? SAMPLES[0]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const loadTables = useCallback(async (force = false) => {
    setTablesLoading(true);
    setTablesError(null);
    try {
      const t = await api.tables(force ? { force: true } : undefined);
      setTables(t);
      // Functional updater keeps this callback stable: depending on `activeTable`
      // made the mount effect re-run the whole schema fetch after the first
      // table was auto-selected (double cold-cache fetch = extra delay).
      setActiveTable((prev) => prev ?? (t.length ? t[0].name : null));
    } catch (e) {
      setTablesError(String(e));
    } finally {
      setTablesLoading(false);
    }
  }, []);

  useEffect(() => { loadTables(); }, [loadTables]);

  const runQuery = useCallback(async (sqlText: string) => {
    setRunning(true); setElapsedMs(null);
    const t0 = performance.now();
    try {
      const r = await api.query(sqlText);
      setResult(r);
    } catch (e) {
      setResult({ columns: [], rows: [], row_count: 0, error: String(e) });
    } finally {
      setElapsedMs(Math.round(performance.now() - t0));
      setRunning(false);
    }
  }, []);

  const run = useCallback(() => runQuery(sql), [runQuery, sql]);

  // Clicking a table previews it: fill the editor with a bounded SELECT * and run it.
  const selectTable = (name: string) => {
    setActiveTable(name);
    const q = `SELECT * FROM options.${name} LIMIT ${TABLE_PREVIEW_LIMIT};`;
    setSql(q);
    runQuery(q);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  };

  const activeCols = useMemo(
    () => tables.find((t) => t.name === activeTable)?.columns ?? [],
    [tables, activeTable],
  );

  const insertName = (name: string) => setSql((s) => (s ? `${s}\n${name}` : name));

  // If the AI copilot opened this lab with SQL via the `sql` search param
  // ("Open in SQL Lab"), seed the editor and run it once.
  useEffect(() => {
    if (initialSql) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="explorer">
      <aside className="explorer-sidebar">
        <div className="sidebar-head">
          <h2>Schema</h2>
          <button className="ghost-btn" onClick={() => loadTables(true)} disabled={tablesLoading} title="Refresh (recompute from the lake)">⟳</button>
        </div>
        {tablesError && <div className="sidebar-error">{tablesError}</div>}
        <ul className="table-list">
          {tables.map((t) => (
            <li key={t.name} className={t.name === activeTable ? 'active' : ''}>
              <button className="table-btn" onClick={() => selectTable(t.name)}>
                <span className="table-name">{t.name}</span>
                <span className="table-count">
                  {t.row_count !== null ? t.row_count.toLocaleString() : '?'}
                </span>
              </button>
            </li>
          ))}
          {tablesLoading && (
            <li className="sidebar-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              <span>Loading schema…</span>
            </li>
          )}
          {!tablesLoading && tables.length === 0 && !tablesError && (
            <li className="muted small">No tables found.</li>
          )}
        </ul>

        {activeTable && (
          <div className="columns-panel">
            <div className="columns-head">
              Fields · <code>{activeTable}</code>
            </div>
            <ul className="column-list">
              {activeCols.map((c) => (
                <li key={c.name}>
                  <button
                    className="col-btn"
                    title="Click to append to query"
                    onClick={() => insertName(c.name)}
                  >
                    <span className="col-name">{c.name}</span>
                    <span className="col-type">{c.type}</span>
                  </button>
                </li>
              ))}
            </ul>
            </div>
        )}
      </aside>

      <main className="explorer-main">
        <div className="editor-bar">
          <span className="hint"><b>Query editor</b> · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to run</span>
          <div className="samples">
            {SAMPLES.map((_, i) => (
              <button key={i} className="sample-btn" onClick={() => setSql(SAMPLES[i])}>
                #{i + 1}
              </button>
            ))}
          </div>
          <button className="run-btn" onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run query'}
          </button>
        </div>
        <textarea
          className="sql-editor"
          value={sql}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKey}
          placeholder="SELECT * FROM options.option_contracts LIMIT 100"
        />

        <div className="result-meta">
          {result?.error ? (
            <span className="err">Error: {result.error}</span>
          ) : result ? (
            <span>
              <b>{result.row_count.toLocaleString()}</b> rows
              {result.truncated ? ` (truncated at ${result.limit})` : ''}
              {elapsedMs !== null ? ` · ${elapsedMs} ms` : ''}
              {' · '}
              <b>{result.columns.length}</b> columns
            </span>
          ) : (
            <span className="muted">Results will appear here.</span>
          )}
        </div>

        <div className="result-wrap">
          {result && !result.error && result.columns.length > 0 && (
            <table className="result-table">
              <thead>
                <tr>
                  <th className="row-idx">#</th>
                  {result.columns.map((c) => <th key={c}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    <td className="row-idx">{i + 1}</td>
                    {result!.columns.map((c) => (
                      <td key={c}>{fmtCell(row[c])}</td>
                    ))}
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr><td colSpan={result.columns.length + 1} className="empty">No rows returned.</td></tr>
                )}
              </tbody>
            </table>
          )}
          {result && !result.error && result.columns.length === 0 && (
            <div className="empty">Query returned no columns.</div>
          )}
        </div>
      </main>
    </div>
  );
}

export default Explorer;
