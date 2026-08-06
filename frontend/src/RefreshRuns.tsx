import { useEffect, useRef, useState } from 'react';
import { api, type RefreshRun } from './api';
import './RefreshRuns.css';

const fmtDateTime = (s: string | null): string => {
  if (!s) return '–';
  const d = new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
};

const statusTone = (status: string): string => {
  const s = status.toLowerCase();
  if (s === 'complete') return 'ok';
  if (s === 'failed') return 'bad';
  return 'run';
};

const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

/** Data-freshness reporting: reads the latest loader refresh runs from the
 * options.refresh_runs Iceberg table (via /api/runs). The header chip shows
 * the newest run's data date + status; the popover lists recent runs. */
export default function RefreshRuns() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RefreshRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Load run history once on mount (data only changes on nightly loader runs).
  useEffect(() => {
    setLoading(true);
    api.runs(10)
      .then(setRuns)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const latest = runs[0];

  if (!latest) {
    return (
      <div className="refresh-runs" ref={wrapRef}>
        <button type="button" className="rr-trigger rr-empty" disabled title="No refresh runs recorded">
          Data n/a
        </button>
      </div>
    );
  }

  return (
    <div className="refresh-runs" ref={wrapRef}>
      <button
        type="button"
        className="rr-trigger"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="How fresh is the data? Click for run history."
      >
        <span className={`rr-dot ${statusTone(latest.status)}`} aria-hidden="true" />
        <span>Data · {latest.as_of_date || 'n/a'} · {latest.status}</span>
      </button>
      {open && (
        <div className="rr-popover" role="dialog" aria-label="Refresh run history">
          <div className="rr-popover-title">
            Refresh runs
            <button className="rr-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <div className="rr-popover-body">
            {loading && runs.length === 0 && <div className="muted">Loading…</div>}
            {error && <div className="rr-error">Could not load run history.</div>}
            {runs.length > 0 && (
              <>
                <p className="rr-latest">
                  Latest run tracked <b>{fmtDateTime(latest.completed_at)}</b> as of{' '}
                  <b>{latest.as_of_date}</b>. {latest.successful_symbols} of {latest.expected_symbols}{' '}
                  symbols loaded ({latest.contract_count.toLocaleString()} contracts).
                </p>
                <table className="rr-table">
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Data as of</th>
                      <th>Completed</th>
                      <th>Symbols</th>
                      <th>Contracts</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.run_id}>
                        <td className="rr-id" title={r.run_id}>{shortId(r.run_id)}</td>
                        <td>{r.as_of_date || '–'}</td>
                        <td>{fmtDateTime(r.completed_at)}</td>
                        <td className="rr-syms">
                          <span className="rr-ok">{r.successful_symbols}</span>
                          {r.failed_symbols > 0 && <span className="rr-fail">/{r.failed_symbols} failed</span>}
                          <span className="muted">/{r.expected_symbols}</span>
                        </td>
                        <td>{r.contract_count.toLocaleString()}</td>
                        <td><span className={`rr-badge ${statusTone(r.status)}`}>{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
