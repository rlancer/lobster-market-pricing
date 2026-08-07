import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import App from './App';
import { useWorkspace } from './App';
import MarketView from './MarketView';
import Explorer from './Explorer';
import AiChat from './AiChat';
import LoaderStatus from './LoaderStatus';
import Notebooks from './Notebooks';
import SymbolDetail from './SymbolDetail';

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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
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
  component: LoaderStatus,
});

const symbolRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/symbol/$symbol',
  component: SymbolDetailView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  researchRoute,
  labRoute,
  aiRoute,
  monitorRoute,
  symbolRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
