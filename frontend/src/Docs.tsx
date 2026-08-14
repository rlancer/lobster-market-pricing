import type { ReactNode } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import './Docs.css';

// ---------------------------------------------------------------------------
// Docs portal — how the whole platform works, end to end. Pure static content
// (no API calls). The portal is split into one page per topic (/docs/<page>);
// DocsLayout is the shell (left nav + content), and each topic exports its own
// page component. Wired to the /docs route tree in router.tsx; linked from the
// header question-mark icon in App.tsx.
// ---------------------------------------------------------------------------

// Left-nav page registry — order matches the section numbers.
const DOCS_PAGES = [
  { to: '/docs/overview', num: '01', label: 'Overview & architecture' },
  { to: '/docs/pipeline', num: '02', label: 'Data pipeline' },
  { to: '/docs/backend', num: '03', label: 'Backend & API' },
  { to: '/docs/exploration', num: '04', label: 'Exploration' },
  { to: '/docs/frontend', num: '05', label: 'Frontend surfaces' },
  { to: '/docs/run', num: '06', label: 'Run it locally' },
  { to: '/docs/deploy', num: '07', label: 'Deployment' },
];

type FlowStep = { glyph: string; title: string; sub: ReactNode };

const FLOW: FlowStep[] = [
  {
    glyph: 'CB',
    title: 'CBOE delayed quotes',
    sub: (
      <>
        Official exchange feed at cdn.cboe.com — options + Greeks, ~15 min
        delayed, no API key.
      </>
    ),
  },
  {
    glyph: 'LD',
    title: 'Loader Worker · cboe-to-r2',
    sub: (
      <>
        Self-sustaining alarm loop in a Durable Object: fetch → OCC-normalize →
        publish. The whole 583-symbol universe refreshes on a ~15 min cadence
        during market hours.
      </>
    ),
  },
  {
    glyph: 'PL',
    title: 'Cloudflare Pipelines',
    sub: (
      <>
        Authenticated HTTP ingest streams that append normalized batches to the
        catalog tables.
      </>
    ),
  },
  {
    glyph: 'LK',
    title: 'R2 Data Catalog · Iceberg lake',
    sub: (
      <>
        Append-only <code>options.*</code> tables — contracts, underlying
        snapshots, refresh runs, OHLC, realized vol.
      </>
    ),
  },
  {
    glyph: 'WK',
    title: 'Screener Worker · screener-api',
    sub: (
      <>
        SELECTs the lake over the R2 SQL REST endpoint, caches 5–10 min, returns
        JSON.
      </>
    ),
  },
  {
    glyph: 'UI',
    title: 'Frontend · Vite + React',
    sub: (
      <>
        Plain <code>fetch('/api/*')</code> client — Chat, Data catalog,
        monitor — and this page.
      </>
    ),
  },
];

const FACTS = [
  ['583', 'symbols per refresh (S&P 500 + ETFs)'],
  ['~1M', 'option contracts per pass'],
  ['~15 min', 'loader cadence + quote delay'],
  ['5 min', 'API cache (10 min liquidity)'],
  ['24/7', 'market-gated loader loop'],
];

const COMPONENTS = [
  {
    dir: 'loader/',
    title: 'CBOE → Pipelines',
    body: 'Owns ingestion: continuous scheduler, jobs for contracts / OHLC / backfill, D1 per-symbol state. Deploys to cboe-to-r2.',
  },
  {
    dir: 'worker/',
    title: 'R2 SQL → JSON',
    body: 'All /api/* endpoints, the in-isolate cache, and the /loader/* pass-through that surfaces live loader state to the monitor.',
  },
  {
    dir: 'frontend/',
    title: 'React UI',
    body: 'Vite + React + TanStack Router. Chat, the Data catalog, monitor — plus the docs portal you are reading.',
  },
];

const JOBS = [
  ['cboe-options', 'Continuous, market-gated', 'The screener\u2019s core feed: CBOE option contracts, underlying snapshots, and refresh runs.'],
  ['ohlc-daily', 'Daily', 'Yahoo daily OHLC (1-year window) + realized volatility computed off split-adjusted closes.'],
  ['ohlc-backfill', 'On demand (POST /jobs/ohlc-backfill/trigger)', 'Item-scoped, resumable historical OHLC backfill; Yahoo dividend/split events land in corporate_actions.'],
  ['etf-daily', 'Daily', 'Yahoo fund profile (expense ratio, AUM, yield) + top-10 holdings for the 65 optionable ETFs.'],
];

const TABLES =
  'option_contracts · underlying_snapshots · refresh_runs · ohlc · realized_vol · securities · symbol_history · corporate_actions · etf_profiles · etf_holdings';

const ENDPOINTS: { method: string; path: string; desc: ReactNode }[] = [
  { method: 'GET', path: '/api/health', desc: <>Liveness check → <code>{'{ok:true}'}</code></> },
  { method: 'GET', path: '/api/stats', desc: 'Underlyings / contracts / calls / puts counts + last-updated timestamp' },
  { method: 'GET', path: '/api/sectors', desc: 'Per-sector symbol count and average spot price' },
  { method: 'GET', path: '/api/underlyings', desc: 'Paginated underlyings (sector, q, liquid_only, limit, offset)' },
  { method: 'GET', path: '/api/symbols', desc: 'Symbol autocomplete for typeaheads' },
  { method: 'GET', path: '/api/liquidity', desc: 'Liquidity-gate defaults + counts (what “liquid” means)' },
  { method: 'GET', path: '/api/screen', desc: 'The screener — filters, sort, pagination (see below)' },
  { method: 'GET', path: '/api/symbol/{symbol}', desc: 'Underlying info + its full option chain from the latest run' },
  { method: 'GET', path: '/api/tables', desc: 'Lake tables with columns/types, row counts, and sample rows (D1-cached; ?force=1 recomputes live)' },
  { method: 'POST', path: '/api/query', desc: <>Run arbitrary read-only SQL against the lake — <code>{'{"sql":"…","limit":1000}'}</code></> },
  { method: 'GET', path: '/api/news', desc: 'Per-ticker headlines (Tavily news search) — Chat get_news tool' },
  { method: 'GET', path: '/api/web_search', desc: 'Open web search (Tavily) — Chat web_search tool' },
  { method: 'GET', path: '/api/econ_calendar', desc: 'Upcoming FRED macro releases + FOMC/Beige (lake + live fallback) — Chat eco_calendar tool' },
  { method: 'GET', path: '/api/notebook/premium', desc: '45-day premium-leaders notebook (calls + puts)' },
  { method: 'GET', path: '/loader/status · /loader/symbols', desc: 'Live loader-loop proxy for the monitor (per-symbol state, backoff, market gate)' },
];

const SURFACES = [
  {
    route: '/',
    title: 'Chat',
    body: 'Natural-language questions grounded in the lake and live APIs (news, web search, FRED/Fed calendar). Optional Google sign-in saves chats into the left nav under Chat; opening one goes to /chat/<id>. Anonymous UUID chats still work. Deep-links into Data so you can inspect the SQL or browse the catalog.',
  },
  {
    route: '/data',
    title: 'Data',
    body: 'Catalog of everything that can feed an answer: Copilot tools, upstream APIs (CBOE, FRED, Fed, Tavily, Yahoo OHLC + ETF profiles, Nasdaq, OpenFIGI), Iceberg lake tables, and a read-only SQL editor.',
  },
  {
    route: '/monitor',
    title: 'Monitor',
    body: 'Refresh-run history from the lake, plus the live loader loop — per-symbol state, backoffs, and the market-hours gate. The header chip jumps here.',
  },
];

const DIALECT_NOTES = [
  <>No <code>OFFSET</code> — the worker fetches the ordered result set once per filter signature (capped at 10,000 rows) and pages slices in memory.</>,
  <>The lake is append-only; every read takes the latest snapshot per symbol: <code>QUALIFY ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY fetched_at DESC) = 1</code>.</>,
  <>No parameter binding — literals are inlined with single-quote escaping via a <code>lit()</code> helper; sort columns are whitelisted.</>,
  <><code>WHERE</code> must come before <code>QUALIFY</code>; no named <code>WINDOW</code> clauses; the spot column is <code>spot_price</code>.</>,
  <>Read-only by construction: only <code>SELECT</code> / <code>WITH</code> / <code>DESCRIBE</code> / <code>SHOW</code> / <code>EXPLAIN</code> are permitted.</>,
];

// Measured against the live lake (option_contracts ≈ 2.29M rows, ~58 MB).
// Seconds per query. "DuckDB cold" = first query in a fresh process (pulls
// Parquet from R2); "DuckDB warm" = re-query in the same process (data cached
// in memory); "R2 SQL" = server-side query (re-scans each time).
const DUCKDB_RESULTS: [string, string, string, string][] = [
  ['stats (counts / last)', '0.6', '0.2', '0.8–2.9'],
  ['liquid_symbols (join + HAVING)', '5.6', '0.5', '1.2–1.6'],
  ['screen_top (near-spot 50, top vol)', '14.9', '1.9', '3.4–3.8'],
  ['symbol_detail AAPL (latest run)', '0.9', '0.7', '0.8'],
  ['sectors (GROUP BY)', '0.26', '0.26', '0.6–1.7'],
];

const DUCKDB_CONNECT = `INSTALL iceberg; LOAD iceberg;   -- DuckDB ≥ 1.4.0
INSTALL httpfs;  LOAD httpfs;
CREATE SECRET r2_secret (TYPE ICEBERG, TOKEN '<R2_DATA_CATALOG_TOKEN>');
ATTACH '<warehouse>' AS r2 (TYPE ICEBERG,
  ENDPOINT 'https://catalog.cloudflarestorage.com/<account>/<bucket>');`;

const DUCKDB_VERDICT = [
  <>The lake is tiny (~58 MB compressed, nightly-refreshed) and the app’s R2 SQL volume stays inside the free tier (10 GB scanned / month, min 10 MB per query) — so DuckDB saves no meaningful money here. Both engines are effectively $0 at this scale.</>,
  <>Cold-to-cold, R2 SQL is faster: it runs server-side adjacent to storage, so it never pays the client-side Parquet pull that makes a fresh DuckDB cold query up to ~15 s on the heavy screen.</>,
  <>DuckDB is dramatically faster on repeats — sub-second vs 1–4 s — but only when it runs as a persistent process that keeps the lake cached across queries. The current Worker already gets “warm” behavior from its 5-min in-isolate result cache, so there is no latency win without standing up a new always-on DuckDB runtime (which would contradict this repo’s serverless, no-local-DB design).</>,
  <>Where DuckDB genuinely helps is offline/ad-hoc analytics: pull the ~60 MB lake once into a local <code>.duckdb</code> file for unlimited free, sub-second, unconstrained SQL — real <code>OFFSET</code>, no 10,000-row LIMIT cap, no resource-gate 400s (limits the R2 SQL dialect imposes).</>,
  <>Experiment scripts: <code>debug_nb/bench_duckdb_vs_r2sql.py</code>, <code>bench_cost.py</code> (gitignored, local only).</>,
];

function Flow() {
  return (
    <ol className="docs-flow">
      {FLOW.map((s, i) => (
        <li key={i} className="docs-flow-step">
          <span className="docs-flow-glyph" aria-hidden="true">{s.glyph}</span>
          <span className="docs-flow-text">
            <b>{s.title}</b>
            <span>{s.sub}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Section({ id, num, title, children }: { id: string; num: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="docs-section">
      <h2><span className="docs-sec-num">{num}</span>{title}</h2>
      {children}
    </section>
  );
}

function Cards({ items }: { items: { title: string; sub?: string; body: string }[] }) {
  return (
    <div className="card-grid">
      {items.map((c) => (
        <div key={c.title} className="docs-card">
          {c.sub && <code className="card-dir">{c.sub}</code>}
          <h3>{c.title}</h3>
          <p>{c.body}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DocsLayout — shared shell: left page nav (sticky) + the active page's body.
// ---------------------------------------------------------------------------
export default function DocsLayout() {
  const { pathname } = useLocation();
  return (
    <div className="docs">
      <nav className="docs-toc" aria-label="Docs pages">
        <span className="docs-toc-title">Docs</span>
        {DOCS_PAGES.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            className={pathname === p.to ? 'docs-toc-link active' : 'docs-toc-link'}
            aria-current={pathname === p.to ? 'page' : undefined}
          >
            <span className="docs-toc-num">{p.num}</span>
            <span>{p.label}</span>
          </Link>
        ))}
      </nav>

      <div className="docs-body">
        <Outlet />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page: 01 · Overview & architecture
// ---------------------------------------------------------------------------
export function DocsOverview() {
  return (
    <>
      <div className="docs-hero">
        <p>
          Lobster MP is a free, end-to-end US equities + ETF options screener built on Cloudflare: CBOE delayed
          quotes land in an Iceberg lake, a Worker serves that lake over R2 SQL, and this React app renders
          it. These pages explain how the whole thing works — where data comes from, how it moves, and where
          each surface you see lives.
        </p>
        <ul className="docs-facts">
          {FACTS.map(([n, label]) => (
            <li key={label}><b>{n}</b><span>{label}</span></li>
          ))}
        </ul>
      </div>

      <Section id="overview" num="01" title="Overview & architecture">
        <div className="docs-container">
          <Flow />
          <p className="docs-note">
            The two Workers are the only runtime code. The loader (<code>loader/</code> → <code>cboe-to-r2</code>)
            owns ingestion end-to-end — no cron, no schedule: a Durable Object alarm loop keeps itself armed.
            The screener Worker (<code>worker/</code> → <code>screener-api</code>) is a thin SQL-string builder
            + cache over the R2 SQL REST endpoint. The frontend is a plain <code>fetch()</code> client — no
            WASM, no Parquet, no in-browser engine.
          </p>
        </div>
        <Cards items={COMPONENTS.map((c) => ({ ...c, sub: c.dir }))} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page: 02 · Data pipeline
// ---------------------------------------------------------------------------
export function DocsPipeline() {
  return (
    <Section id="pipeline" num="02" title="Data pipeline">
      <h3>How the continuous loader works</h3>
      <p className="docs-lede">
        A single <code>EtlScheduler</code> Durable Object runs a self-rescheduling alarm loop. Each pass:
      </p>
      <ol className="docs-ordered">
        <li><b>Seed</b> — the first pass loads <code>symbol_state</code> from the bundled manifest (<code>symbols/universe.json</code>, 583 symbols), all enabled and due immediately.</li>
        <li><b>Pick the batch</b> — due symbols (<code>enabled = 1 AND next_attempt_after &lt;= now</code>), stalest first, capped at <code>LOADER_BATCH_SIZE</code> (40).</li>
        <li><b>Fetch &amp; normalize</b> — each symbol comes down from CBOE, is normalized to OCC form, and is published to Pipelines in symbol order with retries and idempotency keys (8 symbols fetched in parallel per pass).</li>
        <li><b>Bookkeeping</b> — success resets the failure count and reschedules the reload at the cadence (15 min); failure increments <code>consecutive_failures</code> and doubles the backoff 60&nbsp;s → 5&nbsp;min → 30&nbsp;min (capped). No special-casing, no dead symbols.</li>
        <li><b>Re-arm</b> — the alarm re-arms so the cycle never stops; every request to the loader also re-arms it, so a redeploy can’t strand the loop.</li>
      </ol>
      <p className="docs-callout">
        <b>Market-hours gate.</b> Outside 09:30–16:00 ET (overnight, weekends, holidays) there is no new CBOE
        data, so the loop sleeps one far-out alarm and skips passes entirely — no fetches, no Pipeline writes.
      </p>
      <h3>Jobs</h3>
      <div className="docs-table-wrap">
        <table className="docs-table">
          <thead>
            <tr><th>Job</th><th>Cadence</th><th>What it does</th></tr>
          </thead>
          <tbody>
            {JOBS.map(([job, cadence, body]) => (
              <tr key={job}>
                <td><code>{job}</code></td>
                <td>{cadence}</td>
                <td>{body}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>The lake</h3>
      <p className="docs-lede">
        Pipelines sink into the R2 Data Catalog as Iceberg tables under the <code>options.</code> schema.
        These are what every query in this app reads:
      </p>
      <pre className="docs-code">{TABLES}</pre>
      <p className="docs-note">
        The old <code>options.underlyings</code> table was retired — descriptive facts now live in{' '}
        <code>securities</code>, run-history snapshots in <code>underlying_snapshots</code>.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page: 03 · Backend & API
// ---------------------------------------------------------------------------
export function DocsBackend() {
  return (
    <Section id="backend" num="03" title="Backend & API">
      <p className="docs-lede">
        The Worker (<code>worker/</code>) turns the lake into JSON. Every endpoint is read-only and cached
        in-isolate: 5 minutes for data, 10 for the liquidity snapshot — data only changes when the loader
        runs, so staleness is bounded.
      </p>
      <div className="docs-table-wrap">
        <table className="docs-table">
          <thead>
            <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((e) => (
              <tr key={e.path}>
                <td><code className="m-method">{e.method}</code></td>
                <td><code>{e.path}</code></td>
                <td>{e.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>R2 SQL / DataFusion dialect notes</h3>
      <ul className="docs-ordered doc-list">
        {DIALECT_NOTES.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
      <p className="docs-callout">
        <b>Freshness.</b> Uncached lake queries take 1–6&nbsp;s; cached responses are instant. To force
        freshness sooner, redeploy the Worker (clears the isolate cache). Quotes themselves are CBOE-delayed
        ~15 minutes — fine for a screener. Greeks are CBOE-supplied Black-Scholes: theta per calendar day,
        vega/rho per 1.00 of vol/rate.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page: 04 · Exploration — experiments against the live lake, with verdicts.
// ---------------------------------------------------------------------------
export function DocsExploration() {
  return (
    <Section id="exploration" num="04" title="Exploration">
      <p className="docs-lede">
        A running log of experiments against the live lake. Each entry states what was tried, the measured
        results, and the verdict — so future sessions don’t re-run the same investigation.
      </p>
      <h3>DuckDB vs R2 SQL — measured</h3>
      <p className="docs-lede">
        The lake is standard Iceberg REST, so a local DuckDB (≥ 1.4.0) can attach directly and pull the same
        data the Worker queries. Verified against the live lake, seconds per query (best of 2):
      </p>
      <div className="docs-table-wrap">
        <table className="docs-table">
          <thead>
            <tr><th>Query</th><th>DuckDB cold</th><th>DuckDB warm</th><th>R2 SQL</th></tr>
          </thead>
          <tbody>
            {DUCKDB_RESULTS.map(([q, cold, warm, r2sql]) => (
              <tr key={q}>
                <td>{q}</td>
                <td>{cold}</td>
                <td>{warm}</td>
                <td>{r2sql}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <pre className="docs-code">{DUCKDB_CONNECT}</pre>
      <ul className="docs-ordered doc-list">
        {DUCKDB_VERDICT.map((v, i) => (
          <li key={i}>{v}</li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page: 05 · Frontend surfaces
// ---------------------------------------------------------------------------
export function DocsFrontend() {
  return (
    <Section id="frontend" num="05" title="Frontend surfaces">
      <p className="docs-lede">
        The React app (Vite + TanStack Router) is Chat plus a Data catalog on one shell — sidebar navigation plus a header with the liquidity gate and dataset status. The question-mark icon in the header brings you here.
      </p>
      <Cards items={SURFACES.map((s) => ({ title: s.title, sub: s.route, body: s.body }))} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page: 06 · Run it locally
// ---------------------------------------------------------------------------
export function DocsRun() {
  return (
    <Section id="run" num="06" title="Run it locally">
      <p className="docs-lede">
        Everything is pinned via mise — Node 24, Python 3.12, wrangler. Two terminals:
      </p>
      <pre className="docs-code">{`mise trust && mise install   # one-time: trust + install pinned tools
mise run sync                # npm install (frontend + worker)
mise run worker-dev          # Cloudflare Worker  → http://127.0.0.1:8787
mise run frontend            # Vite dev server    → http://127.0.0.1:5173`}</pre>
      <p className="docs-note">
        <code>frontend/.env</code> sets <code>VITE_API_BASE</code> to the deployed Worker
        (<code>https://api.lobster.mp</code>). For local dev, point it at{' '}
        <code>http://127.0.0.1:8787</code> or leave it empty to use the Vite <code>/api</code>{' '}
        proxy. Secrets (<code>R2_SQL_TOKEN</code>, <code>LOADER_TOKEN</code>,{' '}
        <code>BETTER_AUTH_SECRET</code>, Google OAuth) live in <code>.dev.vars</code> for
        local runs — see <code>.env.example</code>.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page: 07 · Deployment
// ---------------------------------------------------------------------------
export function DocsDeploy() {
  return (
    <Section id="deploy" num="07" title="Deployment">
      <ul className="docs-ordered doc-list">
        <li><b>Worker</b> — <code>mise run worker-deploy</code> (wrangler deploy → api.lobster.mp, plus the workers.dev fallback).</li>
        <li><b>Loader</b> — GitHub Action <code>deploy-loader.yml</code> on push to main: deploys <code>cboe-to-r2</code> and applies D1 migrations.</li>
        <li><b>Frontend</b> — GitHub Action <code>deploy.yml</code> on push to main: builds and deploys to Cloudflare Pages (lobster.mp). Preview uses api-dev.lobster.mp so the session cookie can share <code>.lobster.mp</code>.</li>
      </ul>
      <p className="docs-note">
        Credentials are the project’s de-facto secret store: every token lives in GitHub Actions secrets
        plus wherever the runtime needs it (Worker secrets, <code>.env</code> / <code>.dev.vars</code>).
      </p>
    </Section>
  );
}
