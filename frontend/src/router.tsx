import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import App from './App';
import DataPage from './DataPage';
import AiChat from './AiChat';
import SharedChat from './SharedChat';
import LoaderStatus from './LoaderStatus';
import RefreshRuns from './RefreshRuns';
import DocsLayout, { DocsOverview, DocsPipeline, DocsBackend, DocsExploration, DocsFrontend, DocsRun, DocsDeploy } from './Docs';

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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
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
  beforeLoad: () => {
    throw redirect({ to: '/data', search: { sql: undefined, item: undefined } });
  },
});

const symbolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/symbol/$symbol',
  beforeLoad: () => {
    throw redirect({ to: '/data', search: { sql: undefined, item: 'table:option_contracts' } });
  },
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

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share/$shareId',
  component: SharedChat,
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

const docsRoute = docsLayoutRoute.addChildren([
  docsIndexRoute,
  docsOverviewRoute,
  docsPipelineRoute,
  docsBackendRoute,
  docsExplorationRoute,
  docsFrontendRoute,
  docsRunRoute,
  docsDeployRoute,
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  dataRoute,
  labRoute,
  marketRoute,
  researchRoute,
  aiRoute,
  monitorRoute,
  symbolRoute,
  shareRoute,
  docsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
