import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  AppShell,
  HStack,
  MobileNav,
  MobileNavToggle,
  Popover,
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
  IconButton,
  Text,
  Tooltip,
  VStack,
  useAppShellMobile,
  useMediaQuery,
} from '@astryxdesign/core';
import { BookOpen, ChevronDown, ChevronRight, CircleHelp, Database, LineChart, Newspaper, Palette, Search, Sparkles, type LucideIcon } from 'lucide-react';
import './App.css';
import { AuthControls } from './AuthControls';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import LiquidityFilter from './LiquidityFilter';
import MonitorStatus from './MonitorStatus';
import { TickerTypeahead } from './TickerTypeahead';
import { api, useDbReady, type Stats, type UserChat } from './api';
import { authClient } from './auth';
import { CHATS_CHANGED_EVENT, chatPath, parseChatId, sortUserChats } from './chatSession';
import { useWorkspace, WorkspaceContext, type WorkspaceValue } from './workspace';

// ---------------------------------------------------------------------------
// Workspace context — shared by the header (stats counts, liquidity gate) and
// the route views. The context, value type, and useWorkspace hook live in
// ./workspace so this file only exports components (React Fast Refresh).
// ---------------------------------------------------------------------------

type Section = {
  to: string;
  label: string;
  heading: string;
  icon: LucideIcon;
  exact?: boolean;
};
const SECTIONS: Section[] = [
  { to: '/', label: 'Timeline', heading: 'Timeline', icon: Newspaper, exact: true },
  { to: '/chat', label: 'Chat', heading: 'Chat', icon: Sparkles },
  { to: '/research', label: 'Research', heading: 'Research', icon: LineChart },
  { to: '/data', label: 'Data', heading: 'Data catalog', icon: Database },
];

// Monitor / docs / brand remain secondary destinations (header help popover).
const MONITOR_HEADING: Section = { to: '/monitor', label: 'Monitor', heading: 'Dataset monitor', icon: Database };
const DOCS_HEADING: Section = { to: '/docs', label: 'Docs', heading: 'Platform docs', icon: BookOpen };
const BRAND_HEADING: Section = { to: '/brand', label: 'Brand', heading: 'Brand style guide', icon: Palette };

/** Global ticker jump — desktop rail on wide viewports, header on mobile. */
function ResearchSearch({ className }: { className: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const tickerMatch = location.pathname.match(/^\/research\/([^/]+)$/);
  const ticker = tickerMatch?.[1]
    ? decodeURIComponent(tickerMatch[1]).trim().toUpperCase()
    : null;

  return (
    <TickerTypeahead
      className={className}
      value={ticker}
      onSelect={(symbol) => {
        void navigate({ to: '/research/$ticker', params: { ticker: symbol } });
      }}
      onClear={() => {
        if (location.pathname.startsWith('/research')) {
          void navigate({ to: '/research' });
        }
      }}
      isLabelHidden
      size="sm"
      startIcon={Search}
      width="100%"
    />
  );
}

function WorkspaceBrand() {
  const { closeMobileNav } = useAppShellMobile();
  return (
    <SideNavHeading
      as={RouterLink}
      icon={(
        <BlueLobsterLogo
          className="nav-mascot"
          width="var(--size-element-md)"
          height="var(--size-element-md)"
        />
      )}
      heading="Lobster"
      headingHref="/"
      onClick={closeMobileNav}
    />
  );
}

function HelpMenu({
  placement = 'below',
  alignment = 'end',
}: {
  placement?: 'above' | 'below';
  alignment?: 'start' | 'end';
}) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const onDocs = location.pathname.startsWith('/docs');
  const onBrand = location.pathname.startsWith('/brand');
  const active = onDocs || onBrand;

  return (
    <Popover
      placement={placement}
      alignment={alignment}
      label="Help"
      width="16rem"
      isOpen={open}
      onOpenChange={setOpen}
      content={(
        <VStack gap={1} className="help-menu">
          <Link
            to="/docs"
            className={onDocs ? 'help-menu-item active' : 'help-menu-item'}
            aria-current={onDocs ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
            <VStack gap={0.5} className="help-menu-copy">
              <Text type="label" weight="semibold">Docs</Text>
              <Text type="supporting">How the platform works</Text>
            </VStack>
          </Link>
          <Link
            to="/brand"
            className={onBrand ? 'help-menu-item active' : 'help-menu-item'}
            aria-current={onBrand ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            <Palette size={18} strokeWidth={1.75} aria-hidden="true" />
            <VStack gap={0.5} className="help-menu-copy">
              <Text type="label" weight="semibold">Brand</Text>
              <Text type="supporting">Logos, voice, and assets</Text>
            </VStack>
          </Link>
        </VStack>
      )}
    >
      <Tooltip content="Help" hasHoverIndication={false}>
        <button
          type="button"
          className={active || open ? 'docs-link active' : 'docs-link'}
          aria-label="Help"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <CircleHelp size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>
    </Popover>
  );
}

const RouterLink = forwardRef<HTMLAnchorElement, ComponentProps<'a'>>(
  ({ href = '/', ...props }, ref) => {
    const chatId = parseChatId(href.match(/^\/chat\/([^/?#]+)/)?.[1]);
    if (chatId) {
      return <Link ref={ref} to="/chat/$chatId" params={{ chatId }} {...props} />;
    }
    const publicHandle = href.match(/^\/u\/([^/?#]+)/)?.[1];
    if (publicHandle) {
      return <Link ref={ref} to="/u/$handle" params={{ handle: publicHandle }} {...props} />;
    }
    if (href === '/chat') {
      return <Link ref={ref} to="/chat" {...props} />;
    }
    const researchTicker = href.match(/^\/research\/([^/?#]+)/)?.[1];
    if (researchTicker) {
      return <Link ref={ref} to="/research/$ticker" params={{ ticker: researchTicker }} {...props} />;
    }
    if (href === '/research') {
      return <Link ref={ref} to="/research" {...props} />;
    }
    return <Link ref={ref} to={href as '/'} {...props} />;
  },
);
RouterLink.displayName = 'RouterLink';

function useSavedChats() {
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const [chats, setChats] = useState<UserChat[] | null>(null);
  const loadSeqRef = useRef(0);

  const loadChats = useCallback(() => {
    if (!user) {
      setChats(null);
      return;
    }
    const seq = ++loadSeqRef.current;
    api.myChats().then((response) => {
      if (seq !== loadSeqRef.current) return;
      setChats(sortUserChats(response.items));
    }).catch(() => {
      if (seq !== loadSeqRef.current) return;
      setChats([]);
    });
  }, [user]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  useEffect(() => {
    const onChanged = () => { loadChats(); };
    window.addEventListener(CHATS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHATS_CHANGED_EVENT, onChanged);
  }, [loadChats]);

  return (chats ?? []).filter((chat): chat is UserChat & { title: string } => Boolean(chat.title?.trim()));
}

function WorkspaceNavItems({
  activeTo,
  isChat,
  activeChatId,
}: {
  activeTo?: string;
  isChat: boolean;
  activeChatId: string | null;
}) {
  const { closeMobileNav } = useAppShellMobile();
  const history = useSavedChats();
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const historySelected = Boolean(activeChatId && history.some((chat) => chat.chat_id === activeChatId));
  const isTimeline = activeTo === '/' || Boolean(activeTo?.startsWith('/u/'));

  return (
    <>
      <SideNavItem
        as={RouterLink}
        href="/"
        label="Timeline"
        icon={Newspaper}
        isSelected={isTimeline}
        onClick={closeMobileNav}
      />
      <SideNavItem
        as={RouterLink}
        href="/chat"
        label="Chat"
        icon={Sparkles}
        isSelected={isChat && !historySelected}
        onClick={closeMobileNav}
      />
      {history.length > 0 ? (
        <SideNavSection
          title="Chat history"
          endContent={(
            <IconButton
              variant="ghost"
              size="sm"
              label={historyCollapsed ? 'Expand chat history' : 'Collapse chat history'}
              icon={historyCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
            />
          )}
        >
          {historyCollapsed
            ? null
            : history.map((chat) => (
                <SideNavItem
                  key={chat.chat_id}
                  as={RouterLink}
                  href={chatPath(chat.chat_id)}
                  label={chat.title.trim()}
                  isSelected={activeChatId === chat.chat_id}
                  onClick={closeMobileNav}
                />
              ))}
        </SideNavSection>
      ) : null}
      {SECTIONS.filter((section) => section.to !== '/' && section.to !== '/chat').map((section) => (
        <SideNavItem
          key={section.to}
          as={RouterLink}
          href={section.to}
          label={section.label}
          icon={section.icon}
          isSelected={
            section.to === '/research'
              ? Boolean(activeTo?.startsWith('/research'))
              : activeTo === section.to
          }
          onClick={closeMobileNav}
        />
      ))}
    </>
  );
}

function WorkspaceNavigation({
  activeTo,
  isChat,
  activeChatId,
  showSearch = false,
  showTools = false,
}: {
  activeTo?: string;
  isChat: boolean;
  activeChatId: string | null;
  showSearch?: boolean;
  showTools?: boolean;
}) {
  const { liquidOnly, setLiquidOnly } = useWorkspace();

  return (
    <SideNav
      className="workspace-nav"
      header={<WorkspaceBrand />}
      topContent={showSearch ? <ResearchSearch className="nav-research-search" /> : undefined}
      footer={showTools ? (
        <VStack gap={2} className="workspace-nav-tools">
          <LiquidityFilter checked={liquidOnly} onChange={setLiquidOnly} />
          <MonitorStatus />
        </VStack>
      ) : undefined}
      footerIcons={showTools ? (
        <>
          <HelpMenu placement="above" alignment="start" />
          <AuthControls placement="above" alignment="start" />
        </>
      ) : undefined}
    >
      <WorkspaceNavItems activeTo={activeTo} isChat={isChat} activeChatId={activeChatId} />
    </SideNav>
  );
}

function Layout() {
  const db = useDbReady();
  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [liquidOnly, setLiquidOnly] = useState(true); // global liquidity gate
  const [stats, setStats] = useState<Stats | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.stats(liquidOnly));
    } catch {
      /* header stats are best-effort */
    }
  }, [liquidOnly]);
  useEffect(() => { loadStats(); }, [loadStats]);


  // Shared chats (/share/:shareId) are PUBLIC artifacts — a recipient who may
  // never have visited the site gets a bare page with its own minimal chrome
  // (SharedChat's AppShell): no workspace nav, no stats header, no
  // localStorage reads. Skip the whole shell for them.
  if (location.pathname.startsWith('/share/')) {
    return <Outlet />;
  }

  const updatedAt = stats?.last_updated
    ? new Date(stats.last_updated.replace(' ', 'T')).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : '–';

  const isTimeline = location.pathname === '/' || location.pathname.startsWith('/u/');
  const active = isTimeline
    ? SECTIONS[0]
    : [...SECTIONS, MONITOR_HEADING, DOCS_HEADING, BRAND_HEADING].find((s) =>
      s.exact ? location.pathname === s.to : location.pathname.startsWith(s.to),
    );
  const activeChatId = parseChatId(location.pathname.match(/^\/chat\/([^/]+)$/)?.[1]);
  const isCopilot = Boolean(activeChatId) || location.pathname === '/chat' || location.pathname === '/ai';

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

  const value: WorkspaceValue = { liquidOnly, setLiquidOnly, stats, updatedAt };
  const navProps = { activeTo: active?.to, isChat: isCopilot, activeChatId };

  // Responsive contract:
  //   > 768px  full-height SideNav (mascot + ticker search + apps + tools)
  //   <= 768px SideNav collapses to MobileNav; ticker search lives in the header
  return (
    <WorkspaceContext.Provider value={value}>
      <AppShell
        className="app"
        height="fill"
        variant="section"
        contentPadding={0}
        sideNav={(
          <WorkspaceNavigation
            {...navProps}
            showSearch
            showTools
          />
        )}
        mobileNav={{
          hasToggle: false,
          breakpoint: 'md',
          content: (
            <MobileNav header={<WorkspaceBrand />} side="start" label="Lobster">
              <WorkspaceNavItems {...navProps} />
            </MobileNav>
          ),
        }}
        topNav={isMobile ? (
          <HStack as="header" className="topbar" gap={3} vAlign="center">
            <MobileNavToggle label="Open apps" />
            <ResearchSearch className="topbar-research-search" />
            <section className="topbar-tools" aria-label="Workspace controls">
              <HelpMenu />
              <AuthControls />
            </section>
          </HStack>
        ) : undefined}
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