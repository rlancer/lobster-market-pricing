import { useCallback, useContext, createContext, useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import './App.css';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import LiquidityFilter from './LiquidityFilter';
import MonitorStatus from './MonitorStatus';
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

type Section = {
  to: string;
  label: string;
  heading: string;
  glyph: string;
  exact?: boolean;
};
const SECTIONS: Section[] = [
  { to: '/', label: 'Copilot', heading: 'Options Copilot', glyph: 'AI', exact: true },
  { to: '/market', label: 'Market', heading: 'Market screener', glyph: 'MK' },
  { to: '/research', label: 'Research', heading: 'Notebooks & research', glyph: 'RX' },
  { to: '/lab', label: 'SQL Lab', heading: 'SQL Lab', glyph: 'QL' },
];

// The Monitor lives in the header (as the consolidated status chip), not the
// left nav — but the /monitor page still needs its own heading.
const MONITOR_HEADING: Section = { to: '/monitor', label: 'Monitor', heading: 'Dataset monitor', glyph: 'IO' };

// The docs portal lives behind the header question-mark icon, not the left
// nav — the /docs page still needs its own topbar heading.
const DOCS_HEADING: Section = { to: '/docs', label: 'Docs', heading: 'Platform docs', glyph: '?' };

function Layout() {
  const db = useDbReady();
  const navigate = useNavigate();
  const location = useLocation();
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

  const active = [...SECTIONS, MONITOR_HEADING, DOCS_HEADING].find((s) =>
    s.exact ? location.pathname === s.to : location.pathname.startsWith(s.to),
  );

  if (!db.ready) {
    return (
      <main className="app app-loading">
        <section className="db-loading">
          <span className="loading-mark" aria-hidden="true" />
          <b>{db.error ? 'Dataset unavailable' : 'Opening market data'}</b>
          <span>{db.error ? db.error : 'Connecting to the screener API…'}</span>
        </section>
      </main>
    );
  }

  const value: WorkspaceValue = { liquidOnly, setLiquidOnly, stats, sectors, updatedAt };

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="app">
        <aside className="sidebar">
          <header className="brand">
            <span className="brand-mark"><BlueLobsterLogo className="brand-lobster" /></span>
            <span className="brand-text">
              <h1>Lobster MP</h1>
              <small>Options intelligence</small>
            </span>
          </header>

          <nav className="sidenav" aria-label="Workspace">
            {SECTIONS.map((s) => (
              <Link
                key={s.to}
                to={s.to}
                className={[
                  'side-item',
                  active?.to === s.to ? 'active' : '',
                ].join(' ')}
                activeOptions={{ exact: s.exact }}
                search={s.to === '/lab' ? { sql: undefined } : undefined}
              >
                <span className="side-glyph" aria-hidden="true">{s.glyph}</span>
                <span className="side-label">{s.label}</span>
              </Link>
            ))}
          </nav>

          <section className="sidebar-stats" aria-label="Dataset summary">
            <header className="sidebar-stats-head"><span>Market ledger</span><span className="ledger-live">Live</span></header>
            <p className="stat-row"><span>Symbols</span><b>{stats?.underlyings ?? '–'}</b></p>
            <p className="stat-row"><span>Contracts</span><b>{stats?.contracts?.toLocaleString() ?? '–'}</b></p>
            <p className="stat-row calls"><span>Calls</span><b>{stats?.calls?.toLocaleString() ?? '–'}</b></p>
            <p className="stat-row puts"><span>Puts</span><b>{stats?.puts?.toLocaleString() ?? '–'}</b></p>
          </section>

          <footer className="sidebar-foot">
            <span className="mantra">CBOE lake · research surface</span>
          </footer>
        </aside>

        <section className="main-col">
          <header className="topbar">
            <span className="topbar-heading"><span className="topbar-eyebrow">Workspace · {active?.label ?? 'Overview'}</span><h2 className="topbar-title">{active?.heading ?? 'Lobster MP'}</h2></span>
            <div className="topbar-tools">
              <LiquidityFilter checked={liquidOnly} onChange={setLiquidOnly} />
              <MonitorStatus />
              <Link
                to="/docs"
                className={location.pathname === '/docs' ? 'docs-link active' : 'docs-link'}
                title="Docs — how this platform works"
                aria-label="Docs — how this platform works"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9.45 9.15a2.55 2.55 0 1 1 3.5 2.37c-.78.34-1.12.86-1.12 1.66v.22" />
                  <circle cx="11.9" cy="16.3" r="1.05" fill="currentColor" stroke="none" />
                </svg>
              </Link>
            </div>
          </header>

          <main className="content">
            <Outlet />
          </main>

          <footer className="app-footer">
            <span>Research only · Quotes may be delayed</span>
            <span>CBOE / Cloudflare / Iceberg</span>
          </footer>
        </section>
      </div>
    </WorkspaceContext.Provider>
  );
}

export default function App() {
  return <Layout />;
}