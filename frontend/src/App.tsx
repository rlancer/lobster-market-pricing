import { forwardRef, useCallback, useEffect, useState, type ComponentProps } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  AppShell,
  HStack,
  MobileNav,
  MobileNavToggle,
  SideNav,
  SideNavItem,
  Tooltip,
  useAppShellMobile,
} from '@astryxdesign/core';
import { BookOpen, ChartNoAxesCombined, CircleHelp, Database, Sparkles, type LucideIcon } from 'lucide-react';
import './App.css';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import LiquidityFilter from './LiquidityFilter';
import MonitorStatus from './MonitorStatus';
import { api, useDbReady, type SectorRow, type Stats } from './api';
import { isOAuthCallback } from './ai';
import { WorkspaceContext, type WorkspaceValue } from './workspace';

// ---------------------------------------------------------------------------
// Workspace context — shared by the header (stats counts, liquidity gate) and
// the route views (e.g. the screener reads liquidOnly/sectors). The context,
// value type, and useWorkspace hook live in ./workspace so this file only
// exports components (React Fast Refresh requirement).
// ---------------------------------------------------------------------------

type Section = {
  to: string;
  label: string;
  heading: string;
  icon: LucideIcon;
  exact?: boolean;
};
const SECTIONS: Section[] = [
  { to: '/', label: 'Copilot', heading: 'Options Copilot', icon: Sparkles, exact: true },
  { to: '/market', label: 'Market', heading: 'Market screener', icon: ChartNoAxesCombined },
  { to: '/research', label: 'Research', heading: 'Notebooks & research', icon: BookOpen },
  { to: '/lab', label: 'SQL Lab', heading: 'SQL Lab', icon: Database },
];

// Monitor and docs remain secondary destinations in the compact header.
const MONITOR_HEADING: Section = { to: '/monitor', label: 'Monitor', heading: 'Dataset monitor', icon: Database };
const DOCS_HEADING: Section = { to: '/docs', label: 'Docs', heading: 'Platform docs', icon: BookOpen };

const RouterLink = forwardRef<HTMLAnchorElement, ComponentProps<'a'>>(
  ({ href = '/', ...props }, ref) => <Link ref={ref} to={href as '/'} {...props} />,
);
RouterLink.displayName = 'RouterLink';

function WorkspaceNavigation({ activeTo }: { activeTo?: string }) {
  const { closeMobileNav } = useAppShellMobile();

  return (
    <SideNav className="workspace-nav">
      {SECTIONS.map((section) => (
        <SideNavItem
          key={section.to}
          as={RouterLink}
          href={section.to}
          label={section.label}
          icon={section.icon}
          isSelected={activeTo === section.to}
          onClick={closeMobileNav}
        />
      ))}
    </SideNav>
  );
}

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

  const navigation = <WorkspaceNavigation activeTo={active?.to} />;
  const isCopilot = location.pathname === '/' || location.pathname === '/ai';

  return (
    <WorkspaceContext.Provider value={value}>
      <AppShell
        className="app"
        height="fill"
        variant="section"
        contentPadding={0}
        sideNav={navigation}
        mobileNav={{
          hasToggle: false,
          breakpoint: 'md',
          content: (
            <MobileNav header="Apps" side="start">
              {navigation}
            </MobileNav>
          ),
        }}
        topNav={(
          <HStack as="header" className="topbar" gap={3} vAlign="center">
            <MobileNavToggle label="Open apps" />
            <Link to="/" className="app-brand-link" aria-label="Lobster MP home">
              <BlueLobsterLogo className="brand-lobster" />
              <span className="topbar-heading">
                <span className="topbar-eyebrow">{active?.label ?? 'Workspace'}</span>
                <span className="topbar-title">{active?.heading ?? 'Lobster MP'}</span>
              </span>
            </Link>
            <section className="topbar-tools" aria-label="Workspace controls">
              <LiquidityFilter checked={liquidOnly} onChange={setLiquidOnly} />
              <MonitorStatus />
              <Tooltip content="Docs — how this platform works" hasHoverIndication={false}>
                <Link
                  to="/docs"
                  className={location.pathname.startsWith('/docs') ? 'docs-link active' : 'docs-link'}
                  aria-label="Docs — how this platform works"
                >
                  <CircleHelp size={20} strokeWidth={1.75} aria-hidden="true" />
                </Link>
              </Tooltip>
            </section>
          </HStack>
        )}
      >
        <section className={isCopilot ? 'content content-copilot' : 'content'}>
          <Outlet />
        </section>
      </AppShell>
    </WorkspaceContext.Provider>
  );
}

export default function App() {
  return <Layout />;
}