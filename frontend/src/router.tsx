import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import App from './App';
import { useWorkspace } from './App';
import MarketView from './MarketView';
import Explorer from './Explorer';
import AiChat from './AiChat';
import LoaderStatus from './LoaderStatus';
import RefreshRuns from './RefreshRuns';
import Notebooks from './Notebooks';
import SymbolDetail from './SymbolDetail';
import DocsLayout, { DocsOverview, DocsPipeline, DocsBackend, DocsFrontend, DocsRun, DocsDeploy } from './Docs';

// The header now holds a single consolidated status chip that links here; this
// page is where all dataset status detail lives (refresh-run history + the live
// loader loop).
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

function ResearchView() {
  const { liquidOnly } = useWorkspace();
  const navigate = useNavigate();
  return (
    <Notebooks
      liquidOnly={liquidOnly}
      onPickSymbol={(s) => navigate({ to: '/symbol/$symbol', params: { symbol: s } })}
    />
  );
}

function SymbolDetailView() {
  const navigate = useNavigate();
  const { symbol } = useParams({ strict: false }) as { symbol?: string };
  return <SymbolDetail symbol={symbol ?? ''} onBack={() => navigate({ to: '/' })} />;
}

function LabView() {
  // If the AI copilot "opened in SQL Lab" with SQL attached as a search param,
  // seed the editor from it (the Explorer component handles the search param).
  return <Explorer />;
}

const rootRoute = createRootRoute({ component: App });

// Chat is the app's home — front and center when you open the workspace.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AiChat,
});

const marketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/market',
  component: MarketView,
});

const researchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/research',
  component: ResearchView,
});

const labRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/lab',
  validateSearch: (search: Record<string, unknown>) => ({
    sql: typeof search.sql === 'string' ? search.sql : undefined,
  }),
  component: LabView,
});

const aiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ai',
  component: AiChat,
});

const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/monitor',
  component: MonitorView,
});

const symbolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/symbol/$symbol',
  component: SymbolDetailView,
});

// Docs portal — broken out into one page per topic. /docs is the layout shell
// (left nav + Outlet); /docs alone redirects to the Overview page.
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

const docsRoute = docsLayoutRoute.addChildren([
  docsIndexRoute,
  docsOverviewRoute,
  docsPipelineRoute,
  docsBackendRoute,
  docsFrontendRoute,
  docsRunRoute,
  docsDeployRoute,
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  marketRoute,
  researchRoute,
  labRoute,
  aiRoute,
  monitorRoute,
  symbolRoute,
  docsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
