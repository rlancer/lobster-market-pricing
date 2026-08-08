import type { ReactNode } from 'react';
import './Docs.css';

// ---------------------------------------------------------------------------
// Docs portal — how the whole platform works, end to end. Pure static content
// (no API calls); wired to the /docs route in router.tsx and linked from the
// header question-mark icon in App.tsx.
// ---------------------------------------------------------------------------

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
        publish. The whole 503-symbol universe refreshes on a ~15 min cadence
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
        Plain <code>fetch('/api/*')</code> client — screener, copilot, SQL lab,
        monitor — and this page.
      </>
    ),
  },
];

const FACTS = [
  ['503', 'S&P 500 symbols per refresh'],
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
    body: 'Vite + React + TanStack Router. Market screener, AI copilot, notebooks, SQL lab, monitor — plus the docs portal you are reading.',
  },
];

const JOBS = [
  ['cboe-options', 'Continuous, market-gated', 'The screener\u2019s core feed: CBOE option contracts, underlying snapshots, and refresh runs.'],
  ['ohlc-daily', 'Daily', 'Yahoo daily OHLC (1-year window) + realized volatility computed off split-adjusted closes.'],
  ['ohlc-backfill', 'On demand (POST /jobs/ohlc-backfill/trigger)', 'Item-scoped, resumable historical OHLC backfill; Yahoo dividend/split events land in corporate_actions.'],
];

const TABLES =
  'option_contracts · underlying_snapshots · refresh_runs · ohlc · realized_vol · securities · symbol_history · corporate_actions';

const ENDPOINTS: { method: string; path: string; desc: ReactNode }[] = [
  { method: 'GET', path: '/api/health', desc: <>Liveness check → <code>{'{ok:true}'}</code></> },
  { method: 'GET', path: '/api/stats', desc: 'Underlyings / contracts / calls / puts counts + last-updated timestamp' },
  { method: 'GET', path: '/api/sectors', desc: 'Per-sector symbol count and average spot price' },
  { method: 'GET', path: '/api/underlyings', desc: 'Paginated underlyings (sector, q, liquid_only, limit, offset)' },
  { method: 'GET', path: '/api/symbols', desc: 'Symbol autocomplete for typeaheads' },
  { method: 'GET', path: '/api/liquidity', desc: 'Liquidity-gate defaults + counts (what “liquid” means)' },
  { method: 'GET', path: '/api/screen', desc: 'The screener — filters, sort, pagination (see below)' },
  { method: 'GET', path: '/api/symbol/{symbol}', desc: 'Underlying info + its full option chain from the latest run' },
  { method: 'GET', path: '/api/tables', desc: 'Lake tables with columns/types and row counts' },
  { method: 'POST', path: '/api/query', desc: <>Run arbitrary read-only SQL against the lake — <code>{'{"sql":"…","limit":1000}'}</code></> },
  { method: 'GET', path: '/api/notebook/premium', desc: '45-day premium-leaders notebook (calls + puts)' },
  { method: 'GET', path: '/loader/status · /loader/symbols', desc: 'Live loader-loop proxy for the monitor (per-symbol state, backoff, market gate)' },
];

const SURFACES = [
  {
    route: '/',
    title: 'Copilot',
    body: 'Natural-language questions → DataFusion SQL, run via /api/query, answered with the result tables. Bring your own OpenRouter key — it stays in your browser. Deep-links into the SQL Lab.',
  },
  {
    route: '/market',
    title: 'Market screener',
    body: 'Filterable, sortable options screener with the liquidity gate. Click any row to open that symbol\u2019s full chain (/symbol/{symbol}).',
  },
  {
    route: '/research',
    title: 'Research',
    body: 'Notebooks over the lake — e.g. 45-day premium leaders, tunable by days-to-expiry, moneyness band, and minimum volume.',
  },
  {
    route: '/lab',
    title: 'SQL Lab',
    body: 'Schema browser + a read-only query editor (Ctrl/Cmd+Enter to run). Every /api/query surface in one place.',
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

export default function Docs() {
  const jump = (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="docs">
      <nav className="docs-toc" aria-label="Docs contents">
        <span className="docs-toc-title">On this page</span>
        <a href="#overview" onClick={jump('overview')}>Overview &amp; architecture</a>
        <a href="#pipeline" onClick={jump('pipeline')}>Data pipeline</a>
        <a href="#backend" onClick={jump('backend')}>Backend &amp; API</a>
        <a href="#frontend" onClick={jump('frontend')}>Frontend surfaces</a>
        <a href="#run" onClick={jump('run')}>Run it locally</a>
        <a href="#deploy" onClick={jump('deploy')}>Deployment</a>
      </nav>

      <div className="docs-body">
        <div className="docs-hero">
          <p>
            Lobster MP is a free, end-to-end S&P&nbsp;500 options screener built on Cloudflare: CBOE delayed
            quotes land in an Iceberg lake, a Worker serves that lake over R2 SQL, and this React app renders
            it. This page explains how the whole thing works — where data comes from, how it moves, and where
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

        <Section id="pipeline" num="02" title="Data pipeline">
          <h3>How the continuous loader works</h3>
          <p className="docs-lede">
            A single <code>EtlScheduler</code> Durable Object runs a self-rescheduling alarm loop. Each pass:
          </p>
          <ol className="docs-ordered">
            <li><b>Seed</b> — the first pass loads <code>symbol_state</code> from the bundled S&amp;P&nbsp;500 manifest (<code>symbols/sp500.json</code>, 503 symbols), all enabled and due immediately.</li>
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

        <Section id="frontend" num="04" title="Frontend surfaces">
          <p className="docs-lede">
            The React app (Vite + TanStack Router) is five surfaces on one shell — sidebar navigation plus a
            header with the liquidity gate and dataset status. The question-mark icon in the header brings you
            here.
          </p>
          <Cards items={SURFACES.map((s) => ({ title: s.title, sub: s.route, body: s.body }))} />
        </Section>

        <Section id="run" num="05" title="Run it locally">
          <p className="docs-lede">
            Everything is pinned via mise — Node 24, Python 3.12, wrangler. Two terminals:
          </p>
          <pre className="docs-code">{`mise trust && mise install   # one-time: trust + install pinned tools
mise run sync                # npm install (frontend + worker)
mise run worker-dev          # Cloudflare Worker  → http://127.0.0.1:8787
mise run frontend            # Vite dev server    → http://127.0.0.1:5173`}</pre>
          <p className="docs-note">
            <code>frontend/.env</code> sets <code>VITE_API_BASE</code> to the deployed Worker. For local dev,
            point it at <code>http://127.0.0.1:8787</code> or leave it empty to use the Vite <code>/api</code>{' '}
            proxy. Secrets (<code>R2_SQL_TOKEN</code>, <code>LOADER_TOKEN</code>) live in{' '}
            <code>.dev.vars</code> for local runs — see <code>.env.example</code>.
          </p>
        </Section>

        <Section id="deploy" num="06" title="Deployment">
          <ul className="docs-ordered doc-list">
            <li><b>Worker</b> — <code>mise run worker-deploy</code> (wrangler deploy → screener-api.robertlancer.workers.dev).</li>
            <li><b>Loader</b> — GitHub Action <code>deploy-loader.yml</code> on push to main: deploys <code>cboe-to-r2</code> and applies D1 migrations.</li>
            <li><b>Frontend</b> — GitHub Action <code>deploy.yml</code> on push to main: builds and deploys to Cloudflare Pages (lobster.mp).</li>
          </ul>
          <p className="docs-note">
            Credentials are the project’s de-facto secret store: every token lives in GitHub Actions secrets
            plus wherever the runtime needs it (Worker secrets, <code>.env</code> / <code>.dev.vars</code>).
          </p>
        </Section>
      </div>
    </div>
  );
}

