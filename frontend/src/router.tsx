import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import App from './App';
import DataPage from './DataPage';
import AiChat from './AiChat';
import TimelinePage from './Timeline';
import ProfilePage from './Profile';
import AccountPage from './Account';
import MyBotsPage from './MyBots';
import SharedChat from './SharedChat';
import LoaderStatus from './LoaderStatus';
import RefreshRuns from './RefreshRuns';
import ResearchPage from './ResearchPage';
import DocsLayout, { DocsOverview, DocsPipeline, DocsBackend, DocsExploration, DocsFrontend, DocsRun, DocsDeploy, DocsSchwabPnl } from './Docs';
import BrandPage from './Brand';
import BotsPage from './Bots';
import UsersPage from './Users';
import ChatsPage from './Chats';
import TradesPage from './Trades';
import PortfolioPage from './Portfolio';
import ChatExplorePage from './ChatExplore';
import AdminPage from './AdminPage';
import AdminTestRunsPage from './AdminTestRuns';
import NotebooksPage from './Notebooks';
import TextVsImageNotebookPage from './TextVsImageNotebook';
import { parseAsOfSearch } from './asOfDate';
import { parseChatId } from './chatSession';
import { etDateString } from './tickerChartRange';

function asOfSearch(search: Record<string, unknown>): { asof?: string } {
  const asof = parseAsOfSearch(search.asof, etDateString());
  return asof ? { asof } : {};
}

function MonitorView() {
  return (
    <div className="monitor">
      <section className="monitor-runs">
        <h2>Refresh runs</h2>
        <p className="muted">Nightly loader runs — the latest data date and status at a glance.</p>
        <RefreshRuns />
      </section>
      <LoaderStatus />
    </div>
  );
}

const rootRoute = createRootRoute({ component: App });

function redirectToChat(): never {
  throw redirect({ to: '/chat' });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TimelinePage,
});

const chatIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: AiChat,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat/$chatId',
  beforeLoad: ({ params }) => {
    if (!parseChatId(params.chatId)) return redirectToChat();
  },
  component: AiChat,
});

const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/data',
  validateSearch: (search: Record<string, unknown>) => ({
    sql: typeof search.sql === 'string' ? search.sql : undefined,
    item: typeof search.item === 'string' ? search.item : undefined,
  }),
  component: DataPage,
});

// Former SQL Lab / screener / research URLs keep working.
const labRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lab',
  validateSearch: (search: Record<string, unknown>) => ({
    sql: typeof search.sql === 'string' ? search.sql : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/data',
      search: { sql: search.sql, item: search.sql ? 'query' : undefined },
    });
  },
});

const marketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/market',
  beforeLoad: () => {
    throw redirect({ to: '/data', search: { sql: undefined, item: undefined } });
  },
});

const researchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/research',
  validateSearch: asOfSearch,
  component: ResearchPage,
});

const researchTickerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/research/$ticker',
  validateSearch: asOfSearch,
  component: ResearchPage,
});

const symbolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/symbol/$symbol',
  validateSearch: asOfSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/research/$ticker',
      params: { ticker: params.symbol.toUpperCase() },
      search,
    });
  },
});

const aiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ai',
  beforeLoad: () => redirectToChat(),
});

const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monitor',
  component: MonitorView,
});

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share/$shareId',
  component: SharedChat,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/u/$handle',
  component: ProfilePage,
});

const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  component: AccountPage,
});

const myBotsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my-bots',
  component: MyBotsPage,
});

const brandRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/brand',
  component: BrandPage,
});

const botsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bots',
  component: BotsPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users',
  component: UsersPage,
});

const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chats',
  component: ChatsPage,
});

const tradesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/trades',
  component: TradesPage,
});

const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/portfolio',
  validateSearch: (search: Record<string, unknown>): {
    book?: 'schwab' | 'suggested' | 'paper';
    asof?: string;
  } => {
    const asof = asOfSearch(search);
    const book = search.book;
    if (book === 'schwab' || book === 'suggested' || book === 'paper') {
      return { book, ...asof };
    }
    return asof;
  },
  component: PortfolioPage,
});

const copilotRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/copilot',
  beforeLoad: () => {
    throw redirect({ to: '/chat-capabilities', search: { item: undefined } });
  },
});

const chatExploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat-capabilities',
  validateSearch: (search: Record<string, unknown>) => ({
    item: typeof search.item === 'string' ? search.item : undefined,
  }),
  component: ChatExplorePage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
});

const adminTestRunsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/test-runs',
  validateSearch: (search: Record<string, unknown>): { batch?: string } => ({
    batch: typeof search.batch === 'string' ? search.batch : undefined,
  }),
  component: AdminTestRunsPage,
});


const experimentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/experiments',
  component: NotebooksPage,
});

const textVsImageExperimentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/experiments/text-vs-image',
  component: TextVsImageNotebookPage,
});

/** Legacy /notebooks paths redirect to /experiments. */
const notebooksRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notebooks',
  beforeLoad: () => {
    throw redirect({ to: '/experiments' });
  },
});

const textVsImageNotebookRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notebooks/text-vs-image',
  beforeLoad: () => {
    throw redirect({ to: '/experiments/text-vs-image' });
  },
});

const docsLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  component: DocsLayout,
});

const docsIndexRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/docs/overview' });
  },
});

const docsOverviewRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/overview',
  component: DocsOverview,
});

const docsPipelineRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/pipeline',
  component: DocsPipeline,
});

const docsBackendRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/backend',
  component: DocsBackend,
});

const docsExplorationRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/exploration',
  component: DocsExploration,
});

const docsFrontendRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/frontend',
  component: DocsFrontend,
});

const docsRunRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/run',
  component: DocsRun,
});

const docsDeployRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/deploy',
  component: DocsDeploy,
});

const docsSchwabPnlRoute = createRoute({
  getParentRoute: () => docsLayoutRoute,
  path: '/schwab-pnl',
  component: DocsSchwabPnl,
});

const docsRoute = docsLayoutRoute.addChildren([
  docsIndexRoute,
  docsOverviewRoute,
  docsPipelineRoute,
  docsBackendRoute,
  docsExplorationRoute,
  docsFrontendRoute,
  docsRunRoute,
  docsDeployRoute,
  docsSchwabPnlRoute,
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatIndexRoute,
  chatRoute,
  profileRoute,
  accountRoute,
  myBotsRoute,
  dataRoute,
  labRoute,
  marketRoute,
  researchRoute,
  researchTickerRoute,
  aiRoute,
  monitorRoute,
  symbolRoute,
  shareRoute,
  brandRoute,
  botsRoute,
  usersRoute,
  chatsRoute,
  tradesRoute,
  portfolioRoute,
  chatExploreRoute,
  copilotRedirectRoute,
  adminRoute,
  adminTestRunsRoute,
  experimentsRoute,
  textVsImageExperimentRoute,
  notebooksRedirectRoute,
  textVsImageNotebookRedirectRoute,
  docsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
