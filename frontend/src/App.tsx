import { useCallback, useContext, createContext, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import './App.css';
import LiquidityFilter from './LiquidityFilter';
import RefreshRuns from './RefreshRuns';
import { api, useDbReady, type SectorRow, type Stats } from './api';
import { isOAuthCallback } from './ai';

// ---------------------------------------------------------------------------
// Workspace context — shared by the header (stats counts, liquidity gate) and
// the route views (e.g. the screener reads liquidOnly/sectors).
// ---------------------------------------------------------------------------
export interface WorkspaceValue {
  liquidOnly: boolean;
  setLiquidOnly: (v: boolean) => void;
  stats: Stats | null;
  sectors: SectorRow[];
  updatedAt: string;
}
const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace must be used within the app layout');
  return v;
}

function Layout() {
  const db = useDbReady();
  const navigate = useNavigate();
  const [liquidOnly, setLiquidOnly] = useState(true); // global liquidity gate
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectors, setSectors] = useState<SectorRow[]>([]);

  const loadStats = useCallback(async () => {
    try {
      const [s, sec] = await Promise.all([api.stats(liquidOnly), api.sectors(liquidOnly)]);
      setStats(s);
      setSectors(sec);
    } catch {
      /* header stats are best-effort */
    }
  }, [liquidOnly]);
  useEffect(() => { loadStats(); }, [loadStats]);

  // OpenRouter OAuth callback → the Copilot route (/ai) where AiChat performs
  // the code exchange. The callback URL already targets /ai, but this guards
  // against a stale callback landing anywhere else.
  useEffect(() => {
    if (isOAuthCallback() && window.location.pathname !== '/ai') {
      navigate({ to: '/ai' });
    }
  }, [navigate]);

  const updatedAt = stats?.last_updated
    ? new Date(stats.last_updated.replace(' ', 'T')).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '–';

  if (!db.ready) {
    return (
      <div className="app">
        <div className="db-loading">
          <span className="loading-mark" aria-hidden="true" />
          <b>{db.error ? 'Dataset unavailable' : 'Opening market data'}</b>
          <span>{db.error ? db.error : 'Connecting to the screener API…'}</span>
        </div>
      </div>
    );
  }

  const value: WorkspaceValue = { liquidOnly, setLiquidOnly, stats, sectors, updatedAt };

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="app">
        <header className="app-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">🦞</span>
            <span>
              <h1>Lobster MP</h1>
              <small>S&amp;P 500 options screener</small>
            </span>
          </div>
          <div className="header-tools">
            <LiquidityFilter checked={liquidOnly} onChange={setLiquidOnly} />
            <span className="data-status"><StatusDot variant="success" label="Dataset ready" /> Dataset ready</span>
            <span className="updated">As of {updatedAt}</span>
            <RefreshRuns />
          </div>
        </header>

        <nav className="tabs" aria-label="Workspace">
          <Link to="/" className="tab" activeOptions={{ exact: true }} activeProps={{ className: 'tab active' }}>Chat</Link>
          <Link to="/market" className="tab" activeOptions={{ exact: true }} activeProps={{ className: 'tab active' }}>Market</Link>
          <Link to="/research" className="tab" activeProps={{ className: 'tab active' }}>Research</Link>
          <Link to="/lab" className="tab" activeProps={{ className: 'tab active' }} search={{ sql: undefined }}>SQL Lab</Link>
          <Link to="/monitor" className="tab" activeProps={{ className: 'tab active' }}>Monitor</Link>
          <div className="stats" aria-label="Dataset summary">
            <span><b>{stats?.underlyings ?? '–'}</b> symbols</span>
            <span><b>{stats?.contracts?.toLocaleString() ?? '–'}</b> contracts</span>
            <span><b>{stats?.calls?.toLocaleString() ?? '–'}</b> calls</span>
            <span><b>{stats?.puts?.toLocaleString() ?? '–'}</b> puts</span>
          </div>
        </nav>

        <Outlet />

        <footer className="app-footer">
          <span>Market data for research only. Quotes may be delayed.</span>
          <span>CBOE · Cloudflare Worker · R2 SQL · Iceberg lake</span>
        </footer>
      </div>
    </WorkspaceContext.Provider>
  );
}

export default function App() {
  return <Layout />;
}
