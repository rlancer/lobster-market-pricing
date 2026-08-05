import { useCallback, useEffect, useMemo, useState } from 'react';
import './Explorer.css';
import { api, type QueryResult, type TableInfo } from './api';

const SAMPLES = [
  'SELECT * FROM underlyings LIMIT 50',
  'SELECT symbol, COUNT(*) AS contracts, MAX(expiration) AS latest_expiry\nFROM option_contracts\nGROUP BY 1\nORDER BY contracts DESC\nLIMIT 20',
  'SELECT sector, COUNT(*) AS symbols, ROUND(AVG(spot), 2) AS avg_spot\nFROM underlyings\nGROUP BY sector\nORDER BY symbols DESC',
  'SELECT type, COUNT(*) AS n, ROUND(AVG(implied_vol), 4) AS avg_iv,\n         ROUND(AVG(volume), 0) AS avg_vol\nFROM option_contracts\nGROUP BY type',
  'SELECT symbol, expiration, type, strike, bid, ask, volume, implied_vol, delta\nFROM option_contracts\nWHERE volume > 0\nORDER BY volume DESC\nLIMIT 100',
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
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sql, setSql] = useState(SAMPLES[0]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const loadTables = useCallback(async () => {
    try {
      const t = await api.tables();
      setTables(t);
      if (!activeTable && t.length) setActiveTable(t[0].name);
    } catch (e) {
      setTablesError(String(e));
    }
  }, [activeTable]);

  useEffect(() => { loadTables(); }, [loadTables]);

  const run = useCallback(async () => {
    setRunning(true); setElapsedMs(null);
    const t0 = performance.now();
    try {
      const r = await api.query(sql);
      setResult(r);
    } catch (e) {
      setResult({ columns: [], rows: [], row_count: 0, error: String(e) });
    } finally {
      setElapsedMs(Math.round(performance.now() - t0));
      setRunning(false);
    }
  }, [sql]);

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

  return (
    <div className="explorer">
      <aside className="explorer-sidebar">
        <div className="sidebar-head">
          <h2>Schema</h2>
          <button className="ghost-btn" onClick={loadTables} title="Refresh">⟳</button>
        </div>
        {tablesError && <div className="sidebar-error">{tablesError}</div>}
        <ul className="table-list">
          {tables.map((t) => (
            <li key={t.name} className={t.name === activeTable ? 'active' : ''}>
              <button className="table-btn" onClick={() => setActiveTable(t.name)}>
                <span className="table-name">{t.name}</span>
                <span className="table-count">
                  {t.row_count !== null ? t.row_count.toLocaleString() : '?'}
                </span>
              </button>
            </li>
          ))}
          {tables.length === 0 && !tablesError && (
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
            <button
              className="preview-btn"
              onClick={() => setSql(`SELECT * FROM ${activeTable} LIMIT 100;`)}
            >
              Preview {activeTable}
            </button>
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
          placeholder="SELECT * FROM option_contracts LIMIT 100"
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
