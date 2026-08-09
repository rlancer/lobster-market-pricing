import { useCallback, useEffect, useState } from 'react';
import { Tooltip } from '@astryxdesign/core';
import { api, type LoaderFilter, type LoaderStatus, type LoaderSymbol } from './api';
import './LoaderStatus.css';

/**
 * Loading Status monitor — live state of the continuous CBOE refresh loop
 * (the per-symbol D1 `symbol_state` behind /loop/status and /loop/symbols,
 * proxied through the screener as /loader/status and /loader/symbols).
 *
 * Complementary to RefreshRuns (which reads the lake's options.refresh_runs):
 * this shows how the background loader is doing *right now* — loop health,
 * the last pass, per-symbol freshness/backoff/failures.
 *
 * Read-only: no D1 writes from here.
 */

const POLL_MS = 20000; // auto-refresh cadence
const CADENCE_MS = 900 * 1000; // loader cadence (15 min) — the "fresh" window

/** Relative time for an epoch-ms instant (past -> "Xs ago", future -> "in Xs"). */
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

const truncate = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const shortId = (id: string | null): string =>
  id && id.length > 8 ? id.slice(0, 8) : (id ?? '–');

type Badge = 'fresh' | 'stale' | 'retrying' | 'disabled' | 'never';
const BADGE_LABEL: Record<Badge, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  retrying: 'Retrying',
  disabled: 'Disabled',
  never: 'Never loaded',
};

/** Badge precedence: Disabled > Retrying > Never loaded > Stale > Fresh. */
const badgeOf = (s: LoaderSymbol, marketOpen: boolean | undefined): Badge => {
  if (s.enabled === 0) return 'disabled';
  if (s.consecutive_failures > 0) return 'retrying';
  if (!s.last_success_at) return 'never';
  // While the market is closed the loop is paused until the next open; a
  // symbol with data is as current as it can possibly be, so it isn't "stale"
  // (it just can't be refreshed yet). Only report staleness during a live
  // session.
  if (!marketOpen) return 'fresh';
  const stale =
    Date.now() - s.last_success_at > CADENCE_MS || s.next_attempt_after <= Date.now();
  return stale ? 'stale' : 'fresh';
};

const FILTERS: LoaderFilter[] = ['all', 'failing', 'retrying', 'stale', 'disabled'];

const MARKET_REASON: Record<string, string> = {
  overnight: 'before the regular 09:30 ET session',
  'after-hours': 'after the 16:00 ET close',
  weekend: 'weekend',
  holiday: 'US market holiday',
};

/** Next open as a short ET date/time string ("Mon, Sep 7, 9:30 AM"). */
const fmtOpen = (mkt: NonNullable<LoaderStatus['market']>): string => {
  if (!mkt.next_open_et) return 'the next session';
  const d = new Date(mkt.next_open_et);
  if (Number.isNaN(d.getTime())) return 'the next session';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
};

export default function LoaderStatus() {
  const [status, setStatus] = useState<LoaderStatus | null>(null);
  const [symbols, setSymbols] = useState<LoaderSymbol[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<LoaderFilter>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.loaderStatus(),
      api.loaderSymbols({ filter, q: q || undefined, sort: 'symbol', limit: 500 }),
    ])
      .then(([st, res]) => {
        setStatus(st);
        setSymbols(res.items ?? []);
        setTotal(res.total ?? 0);
        setError(null);
        setLastUpdated(new Date());
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [filter, q]);

  // Initial load + reload when filters change.
  useEffect(() => { load(); }, [load]);

  // Auto-refresh; pause while the tab is hidden.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const counts = status?.counts;
  const lp = status?.last_pass;
  const mkt = status?.market;

  return (
    <div className="loader-status">
      <div className="ls-head">
        <h2>Loading Status</h2>
        <p className="muted">
          Live state of the continuous CBOE refresh loop (per-symbol D1, read-only).
        </p>
      </div>

      {mkt && mkt.open === false && (
        <div className="ls-market-closed" role="status">
          <b>Market closed — refreshes paused</b>
          <span>
            {MARKET_REASON[mkt.reason ?? ''] ? `Reason: ${MARKET_REASON[mkt.reason ?? '']}. ` : ''}
            Resumes {fmtOpen(mkt)} ET.
          </span>
        </div>
      )}

      {error && (
        <div className="ls-error" role="alert">
          <b>Loader offline / error</b>
          <span>{error} — the background loader may be unreachable. Auto-retrying…</span>
        </div>
      )}

      <div className="ls-cards">
        <div className="ls-card">
          <span className="ls-card-label">Total symbols</span>
          <b>{counts?.total ?? '–'}</b>
        </div>
        <div className="ls-card">
          <span className="ls-card-label">Enabled</span>
          <b>{counts?.enabled ?? '–'}</b>
        </div>
        <div className="ls-card">
          <span className="ls-card-label">Due now</span>
          <b>{counts?.due ?? '–'}</b>
        </div>
        <div className="ls-card">
          <span className="ls-card-label">Failing</span>
          <b className={counts && counts.failing > 0 ? 'ls-danger' : ''}>{counts?.failing ?? '–'}</b>
        </div>
        <div className="ls-card ls-card-wide">
          <span className="ls-card-label">Loop health</span>
          <b>
            {mkt && mkt.open === false ? (
              <>
                <span className="ls-dot muted" aria-hidden="true" />
                Paused — market closed
                <span className="muted">{mkt.next_open_et ? ` · resumes ${fmtOpen(mkt)} ET` : ''}</span>
              </>
            ) : (
              <>
                <span className={`ls-dot ${status?.passing ? 'run' : 'ok'}`} aria-hidden="true" />
                {status?.passing ? 'Running a pass now' : 'Idle'}
                <span className="muted"> · next refresh {status?.next_alarm != null ? rel(status.next_alarm) : '–'}</span>
              </>
            )}
          </b>
        </div>
      </div>

      <div className="ls-lastpass">
        {lp ? (
          <span>
            Last pass · <b>{rel(lp.finished_at)}</b>{' '}
            <span className="muted">
              (run <code>{shortId(lp.run_id)}</code> · {fmtDur(lp.duration_ms)} ·{' '}
            </span>
            {lp.attempted} attempted / <b>{lp.succeeded}</b> ok
            {lp.failed > 0 && <b className="ls-danger"> / {lp.failed} failed</b>}
            {lp.transport_error && <span className="muted"> · transport: {lp.transport_error}</span>}
            )
          </span>
        ) : (
          <span className="muted">No pass recorded yet.</span>
        )}
      </div>

      <div className="ls-toolbar">
        <label className="ls-filter">
          Filter
          <select value={filter} onChange={(e) => setFilter(e.target.value as LoaderFilter)}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>{f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}</option>
            ))}
          </select>
        </label>
        <input
          className="ls-search"
          type="search"
          placeholder="Search symbol…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search symbol"
        />
        <label className="ls-autorefresh">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh ({Math.round(POLL_MS / 1000)}s)
        </label>
        <button type="button" className="ls-refresh" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <span className="ls-updated muted">
          Updated {lastUpdated ? rel(lastUpdated.getTime()) : '–'}
        </span>
      </div>

      <div className="ls-meta">
        <span>
          <b>{symbols.length.toLocaleString()}</b> shown{' '}
          <span className="meta-separator">/</span> <b>{total.toLocaleString()}</b> matching
        </span>
      </div>

      <div className="ls-table-wrap">
        <table className="ls-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Status</th>
              <th>Last success</th>
              <th>Last attempt</th>
              <th>Failures</th>
              <th>Backoff / next retry</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {symbols.map((s) => {
              const b = badgeOf(s, status?.market?.open);
              return (
                <tr key={s.symbol}>
                  <td><b>{s.symbol}</b></td>
                  <td><span className={`ls-badge ${b}`}>{BADGE_LABEL[b]}</span></td>
                  <td>{rel(s.last_success_at)}</td>
                  <td className="muted">{rel(s.last_attempt_at)}</td>
                  <td className={s.consecutive_failures > 0 ? 'ls-danger' : ''}>
                    {s.consecutive_failures}
                  </td>
                  <td>
                    {s.consecutive_failures > 0
                      ? `${fmtDur(s.backoff_seconds * 1000)} · retry ${rel(s.next_attempt_after)}`
                      : '–'}
                  </td>
                  <td className="ls-err">
                    <Tooltip content={s.last_error ?? ''} isEnabled={!!s.last_error} hasHoverIndication={false}>
                      <span>{s.last_error ? truncate(s.last_error, 60) : '–'}</span>
                    </Tooltip>
                  </td>
                </tr>
              );
            })}
            {symbols.length === 0 && !loading && (
              <tr><td colSpan={7} className="empty">No symbols match the current filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
