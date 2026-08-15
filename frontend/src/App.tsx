import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentProps, type MouseEvent } from 'react';
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
import { BookOpen, CircleHelp, Database, Sparkles, type LucideIcon } from 'lucide-react';
import './App.css';
import { Sunglasses } from './Sunglasses';
import { AuthControls } from './AuthControls';
import LiquidityFilter from './LiquidityFilter';
import MonitorStatus from './MonitorStatus';
import { api, useDbReady, type Stats, type UserChat } from './api';
import { authClient } from './auth';
import { CHATS_CHANGED_EVENT, chatPath, parseChatId, rememberChatId, sortUserChats } from './chatSession';
import { WorkspaceContext, type WorkspaceValue } from './workspace';

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
  { to: '/', label: 'Chat', heading: 'Chat', icon: Sparkles, exact: true },
  { to: '/data', label: 'Data', heading: 'Data catalog', icon: Database },
];

// Monitor and docs remain secondary destinations in the compact header.
const MONITOR_HEADING: Section = { to: '/monitor', label: 'Monitor', heading: 'Dataset monitor', icon: Database };
const DOCS_HEADING: Section = { to: '/docs', label: 'Docs', heading: 'Platform docs', icon: BookOpen };

const RouterLink = forwardRef<HTMLAnchorElement, ComponentProps<'a'>>(
  ({ href = '/', ...props }, ref) => {
    const chatId = parseChatId(href.match(/^\/chat\/([^/?#]+)/)?.[1]);
    if (chatId) {
      return <Link ref={ref} to="/chat/$chatId" params={{ chatId }} {...props} />;
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

function WorkspaceNavigation({
  activeTo,
  isChat,
  activeChatId,
}: {
  activeTo?: string;
  isChat: boolean;
  activeChatId: string | null;
}) {
  const { closeMobileNav } = useAppShellMobile();
  const navigate = useNavigate();
  const history = useSavedChats();
  const historySelected = Boolean(activeChatId && history.some((chat) => chat.chat_id === activeChatId));
  const liveChatId = activeChatId && !historySelected ? activeChatId : null;

  const goToChat = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    closeMobileNav();
    if (liveChatId) {
      void navigate({ to: '/chat/$chatId', params: { chatId: liveChatId } });
      return;
    }
    const created = crypto.randomUUID();
    rememberChatId(created);
    void navigate({ to: '/chat/$chatId', params: { chatId: created } });
  };

  return (
    <SideNav className="workspace-nav">
      <SideNavItem
        as={RouterLink}
        href={liveChatId ? chatPath(liveChatId) : '/'}
        label="Chat"
        icon={Sparkles}
        isSelected={isChat && !historySelected}
        onClick={goToChat}
      />
      {history.length > 0 ? (
        <SideNavItem label="Chat history" collapsible>
          {history.map((chat) => (
            <SideNavItem
              key={chat.chat_id}
              as={RouterLink}
              href={chatPath(chat.chat_id)}
              label={chat.title.trim()}
              size="sm"
              isSelected={activeChatId === chat.chat_id}
              onClick={closeMobileNav}
            />
          ))}
        </SideNavItem>
      ) : null}
      {SECTIONS.filter((section) => section.to !== '/').map((section) => (
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
  const location = useLocation();
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

  const active = [...SECTIONS, MONITOR_HEADING, DOCS_HEADING].find((s) =>
    s.exact ? location.pathname === s.to : location.pathname.startsWith(s.to),
  );
  const activeChatId = parseChatId(location.pathname.match(/^\/chat\/([^/]+)$/)?.[1]);
  const isCopilot = Boolean(activeChatId) || location.pathname === '/' || location.pathname === '/ai';

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

  const navigation = <WorkspaceNavigation activeTo={active?.to} isChat={isCopilot} activeChatId={activeChatId} />;

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
              <Sunglasses className="brand-sunglasses" />
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
            <AuthControls />
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