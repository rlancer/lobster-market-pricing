import type { QueryResult } from './api';

export const MAX_RENDER_ROWS = 200;

function fmtCell(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
}

export function ResultTable({ result }: { result: QueryResult }) {
  if (result.error) return <div className="ai-err">Query error: {result.error}</div>;
  if (!result.columns.length) return <div className="ai-empty">Query returned no columns.</div>;
  const shown = result.rows.slice(0, MAX_RENDER_ROWS);
  return (
    <div className="ai-result">
      <div className="ai-result-meta">
        <b>{result.row_count.toLocaleString()}</b> rows · {result.columns.length} columns
        {result.truncated ? ` · first ${result.limit}` : ''}
      </div>
      <div className="ai-result-scroll">
        <table className="ai-result-table">
          <thead>
            <tr>
              <th className="ai-idx">#</th>
              {result.columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                <td className="ai-idx">{index + 1}</td>
                {result.columns.map((column) => <td key={column}>{fmtCell(row[column])}</td>)}
              </tr>
            ))}
            {result.row_count > shown.length && (
              <tr>
                <td colSpan={result.columns.length + 1} className="ai-empty">
                  … {result.row_count - shown.length} more rows
                </td>
              </tr>
            )}
            {shown.length === 0 && (
              <tr><td colSpan={result.columns.length + 1} className="ai-empty">No rows returned.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
