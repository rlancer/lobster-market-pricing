import { useCallback, useEffect, useState } from 'react';
import { api, type PositionMarkSnapStatus } from './api';
import { useIsAdmin } from './useAdmin';
import './PositionMarkStatus.css';

/**
 * Dataset monitor card for the hourly position-mark snap cron.
 * Complements LoaderStatus — paper/bot book MTM health + last pass ledger.
 */

const POLL_MS = 30000;

const rel = (ms: number | null | undefined): string => {
  if (ms == null) return '–';
  const s = Math.round((ms - Date.now()) / 1000);
  if (s >= 0) {
    if (s < 60) return s <= 1 ? 'now' : `in ${s}s`;
    if (s < 3600) return `in ${Math.floor(s / 60)}m`;
    return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const a = -s;
  if (a < 60) return `${a}s ago`;
  if (a < 3600) return `${Math.floor(a / 60)}m ago`;
  return `${Math.floor(a / 3600)}h ${Math.floor((a % 3600) / 60)}m ago`;
};

const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null) return '–';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
};

export default function PositionMarkStatus() {
  const { isAdmin, isPending } = useIsAdmin();
  const [status, setStatus] = useState<PositionMarkSnapStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    if (!isAdmin) return;
    setLoading(true);
    api
      .positionMarkStatus()
      .then((st) => {
        setStatus(st);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(() => {
    if (!isPending && isAdmin) load();
  }, [isPending, isAdmin, load]);

  useEffect(() => {
    if (!autoRefresh || !isAdmin) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, isAdmin, load]);

  const runSnap = async () => {
    if (!isAdmin || snapping) return;
    setSnapping(true);
    setNotice(null);
    try {
      const summary = await api.positionMarkSnap();
      setNotice(
        `Snap finished · ${summary.marked} marked / ${summary.scanned} scanned`
        + (summary.failed > 0 ? ` / ${summary.failed} failed` : ''),
      );
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSnapping(false);
    }
  };

  if (isPending) {
    return (
      <div className="position-mark-status">
        <div className="pms-head">
          <h2>Position mark snap</h2>
          <p className="muted">Checking admin access…</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="position-mark-status">
        <div className="pms-head">
          <h2>Position mark snap</h2>
          <p className="muted">
            Hourly Worker cron that remakes open paper and bot books into daily mark history.
            Sign in as an admin to see last-pass health and force a snap.
          </p>
        </div>
      </div>
    );
  }

  const state = status?.state;
  const books = status?.books;
  const failing = (state?.consecutive_failures ?? 0) > 0 || (state?.last_ok === 0);
  const staleBooks = (books?.stale_open ?? 0) + (books?.never_marked ?? 0) > 0;
  const healthTone = failing ? 'bad' : staleBooks ? 'run' : 'ok';
  const healthLabel = failing
    ? 'Last pass failed'
    : staleBooks
      ? 'Open marks going stale'
      : state?.last_finished_at
        ? 'Healthy'
        : 'No pass yet';

  return (
    <div className="position-mark-status">
      <div className="pms-head">
        <h2>Position mark snap</h2>
        <p className="muted">
          Hourly Worker cron (<code>{status?.cron ?? '5 * * * *'}</code>) remakes open paper and bot
          positions into durable daily mark history — so day-over-day PnL does not depend on
          someone opening Portfolio.
        </p>
      </div>

      {error && (
        <div className="pms-error" role="alert">
          <b>Status unavailable</b>
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="pms-notice" role="status">
          {notice}
        </div>
      )}

      <div className="pms-cards">
        <div className="pms-card pms-card-wide">
          <span className="pms-card-label">Job health</span>
          <b>
            <span className={`pms-dot ${healthTone}`} aria-hidden="true" />
            {healthLabel}
            <span className="muted">
              {' · '}last pass {state?.last_finished_at != null ? rel(state.last_finished_at) : '–'}
            </span>
          </b>
        </div>
        <div className="pms-card">
          <span className="pms-card-label">Open positions</span>
          <b>{books?.open_total ?? '–'}</b>
          <span className="muted">
            {books ? `${books.paper_open} paper · ${books.bot_open} bot` : ''}
          </span>
        </div>
        <div className="pms-card">
          <span className="pms-card-label">Stale / never marked</span>
          <b className={staleBooks ? 'pms-danger' : ''}>
            {(books?.stale_open ?? 0) + (books?.never_marked ?? 0) || '–'}
          </b>
          <span className="muted">
            {books
              ? `${books.stale_open} stale · ${books.never_marked} never`
              : ''}
          </span>
        </div>
        <div className="pms-card">
          <span className="pms-card-label">Last snap</span>
          <b>
            {state?.last_marked != null ? state.last_marked : '–'}
            <span className="muted"> marked</span>
          </b>
          <span className="muted">
            {state
              ? `${state.last_scanned ?? 0} scanned · ${fmtDur(state.last_duration_ms)}`
              : ''}
          </span>
        </div>
      </div>

      <div className="pms-lastpass">
        {state?.last_finished_at != null ? (
          <span>
            Last pass · <b>{rel(state.last_finished_at)}</b>{' '}
            <span className="muted">
              ({fmtDur(state.last_duration_ms)} · {state.last_scanned ?? 0} scanned /{' '}
              <b>{state.last_marked ?? 0}</b> marked
              {(state.last_failed ?? 0) > 0 && (
                <b className="pms-danger"> / {state.last_failed} failed</b>
              )}
              {(state.consecutive_failures ?? 0) > 0 && (
                <b className="pms-danger"> · {state.consecutive_failures} consecutive failure(s)</b>
              )}
              {state.last_error ? ` · ${state.last_error}` : ''}
              )
            </span>
          </span>
        ) : (
          <span className="muted">No mark-snap pass recorded yet — run one or wait for the hourly cron.</span>
        )}
      </div>

      <div className="pms-toolbar">
        <label className="pms-toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <button type="button" className="pms-btn" disabled={loading || snapping} onClick={() => load()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button type="button" className="pms-btn pms-btn-primary" disabled={snapping} onClick={() => { void runSnap(); }}>
          {snapping ? 'Snapping…' : 'Force snap'}
        </button>
        {lastUpdated && (
          <span className="muted pms-updated">Updated {lastUpdated.toLocaleTimeString()}</span>
        )}
      </div>

      {(status?.recent_passes?.length ?? 0) > 0 && (
        <div className="pms-passes">
          <h3>Recent passes</h3>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>Marked</th>
                <th>Scanned</th>
                <th>Failed</th>
                <th>Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {status!.recent_passes.map((p) => (
                <tr key={p.id}>
                  <td>{rel(p.finished_at)}</td>
                  <td>{p.source}</td>
                  <td>{p.marked ?? '–'}</td>
                  <td>{p.scanned ?? '–'}</td>
                  <td className={(p.failed ?? 0) > 0 ? 'pms-danger' : ''}>{p.failed ?? '–'}</td>
                  <td>{fmtDur(p.duration_ms)}</td>
                  <td className={p.ok ? '' : 'pms-danger'}>{p.ok ? 'ok' : (p.error ?? 'failed')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
