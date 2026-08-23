import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import {
  AppShell,
  Center,
  Divider,
  Layout,
  MobileNav,
  SideNav,
  SideNavItem,
  SideNavSection,
  IconButton,
  VStack,
  useAppShellMobile,
} from '@astryxdesign/core';
import { BookOpen, Briefcase, ChevronDown, ChevronRight, Database, Lock, Newspaper, Search, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import './App.css';
import { isAdminNavPath } from './admin';
import { useIsAdmin } from './useAdmin';
import { AuthControls } from './AuthControls';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { TickerTypeahead } from './TickerTypeahead';
import { api, useDbReady, type Stats, type UserChat } from './api';
import { authClient } from './auth';
import {
  CHATS_CHANGED_EVENT,
  chatPath,
  groupUserChatsByRelativeTime,
  parseChatId,
  sortUserChats,
} from './chatSession';
import { DocumentMeta } from './DocumentMeta';
import { WorkspaceContext, type WorkspaceValue } from './workspace';

// ---------------------------------------------------------------------------
// Workspace context — shared by the shell (stats counts, dataset chip) and
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
  { to: '/portfolio', label: 'Portfolio', heading: 'Paper portfolio', icon: Briefcase },
];

// Data, Docs, Admin, and account sit under a divider at the bottom of the left
// nav. Research lives behind the ticker search (no dedicated nav link). Dataset
// status lives on the Admin hub.
const BOTTOM_SECTIONS: Section[] = [
  { to: '/data', label: 'Data', heading: 'Data catalog', icon: Database },
];
const MONITOR_HEADING: Section = { to: '/monitor', label: 'Monitor', heading: 'Dataset monitor', icon: Database };
const DOCS_HEADING: Section = { to: '/docs', label: 'Docs', heading: 'Platform docs', icon: BookOpen };
const ADMIN_HEADING: Section = { to: '/admin', label: 'Admin', heading: 'Admin', icon: Wrench };

/** Global ticker jump — desktop rail on wide viewports, drawer on mobile. */
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
    <Center axis="horizontal" width="100%" className="nav-brand">
      <RouterLink
        href="/"
        className="nav-brand-link"
        aria-label="Lobster home"
        onClick={closeMobileNav}
      >
        <BlueLobsterLogo className="nav-mascot" />
      </RouterLink>
    </Center>
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
  const historyGroups = groupUserChatsByRelativeTime(history);
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
            : historyGroups.map((group) => (
                <SideNavSection key={group.label} title={group.label}>
                  {group.items.map((chat) => (
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
              ))}
        </SideNavSection>
      ) : null}
    </>
  );
}

function WorkspaceHelpNavItems({
  activeTo,
  pathname,
}: {
  activeTo?: string;
  pathname: string;
}) {
  const { closeMobileNav } = useAppShellMobile();
  const { isAdmin } = useIsAdmin();
  const adminSelected = isAdminNavPath(pathname);

  return (
    <>
      {BOTTOM_SECTIONS.map((section) => (
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
      <SideNavItem
        as={RouterLink}
        href="/docs"
        label={DOCS_HEADING.label}
        icon={DOCS_HEADING.icon}
        isSelected={Boolean(activeTo?.startsWith('/docs'))}
        onClick={closeMobileNav}
      />
      {isAdmin ? (
        <SideNavItem
          as={RouterLink}
          href="/admin"
          label={ADMIN_HEADING.label}
          icon={ADMIN_HEADING.icon}
          isSelected={adminSelected}
          endContent={<Lock size={14} aria-label="Admin only" />}
          onClick={closeMobileNav}
        />
      ) : null}
    </>
  );
}

function WorkspaceAccountNav() {
  return (
    <VStack className="nav-account" gap={2} width="100%">
      <AuthControls placement="above" alignment="start" />
    </VStack>
  );
}

function WorkspaceHelpNav({
  activeTo,
  pathname,
}: {
  activeTo?: string;
  pathname: string;
}) {
  return (
    <>
      <VStack paddingBlock={3} width="100%">
        <Divider isFullBleed variant="strong" />
      </VStack>
      <WorkspaceHelpNavItems activeTo={activeTo} pathname={pathname} />
      <WorkspaceAccountNav />
    </>
  );
}

function WorkspaceNavigation({
  activeTo,
  pathname,
  isChat,
  activeChatId,
  showSearch = false,
}: {
  activeTo?: string;
  pathname: string;
  isChat: boolean;
  activeChatId: string | null;
  showSearch?: boolean;
}) {
  return (
    <SideNav
      className="workspace-nav"
      header={<WorkspaceBrand />}
      topContent={showSearch ? <ResearchSearch className="nav-research-search" /> : undefined}
      footer={<WorkspaceHelpNav activeTo={activeTo} pathname={pathname} />}
    >
      <WorkspaceNavItems activeTo={activeTo} isChat={isChat} activeChatId={activeChatId} />
    </SideNav>
  );
}

function WorkspaceLayout() {
  const db = useDbReady();
  const location = useLocation();
  const [stats, setStats] = useState<Stats | null>(null);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api.stats());
    } catch {
      /* dataset stats are best-effort */
    }
  }, []);
  useEffect(() => { loadStats(); }, [loadStats]);


  // Shared chats (/share/:shareId) are PUBLIC artifacts — a recipient who may
  // never have visited the site gets a bare page with its own minimal chrome
  // (SharedChat's AppShell): no workspace nav, no stats chrome, no
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
    : isAdminNavPath(location.pathname)
      ? ADMIN_HEADING
      : [...SECTIONS, ...BOTTOM_SECTIONS, MONITOR_HEADING, DOCS_HEADING].find((s) =>
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

  const value: WorkspaceValue = { stats, updatedAt };
  const navProps = {
    activeTo: active?.to,
    pathname: location.pathname,
    isChat: isCopilot,
    activeChatId,
  };

  // Responsive contract:
  //   > 768px  SideNav spans the viewport; content fills the rest (no top bar).
  //   <= 768px SideNav collapses to MobileNav; AppShell owns the menu toggle;
  //            ticker search + account/status live in the drawer with the links.
  return (
    <WorkspaceContext.Provider value={value}>
      <AppShell
        className="app"
        height="fill"
        variant="section"
        contentPadding={0}
        sideNav={<WorkspaceNavigation {...navProps} showSearch />}
        mobileNav={{
          hasToggle: true,
          breakpoint: 'md',
          content: (
            <MobileNav side="start" label="Lobster">
              <WorkspaceBrand />
              <ResearchSearch className="nav-research-search" />
              <WorkspaceNavItems
                activeTo={navProps.activeTo}
                isChat={navProps.isChat}
                activeChatId={navProps.activeChatId}
              />
              <WorkspaceHelpNav activeTo={navProps.activeTo} pathname={navProps.pathname} />
            </MobileNav>
          ),
        }}
      >
        <Layout className="workspace-main" height="fill" padding={0}>
          <section className={isCopilot ? 'content content-copilot' : 'content'}>
            <Outlet />
          </section>
        </Layout>
      </AppShell>
    </WorkspaceContext.Provider>
  );
}

export default function App() {
  return (
    <DocumentMeta>
      <WorkspaceLayout />
    </DocumentMeta>
  );
}