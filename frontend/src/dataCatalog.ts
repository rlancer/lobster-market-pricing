/** Static catalog of everything Chat can draw on: Copilot tools, upstream
 *  APIs/feeds, and Iceberg lake tables. Live row counts and columns come from
 *  `/api/tables`; this file is the human-readable map of what each source is
 *  and how it lands in an answer. */

export type CatalogKind = 'overview' | 'tool' | 'feed' | 'table' | 'query';

export interface CatalogParam {
  name: string;
  type: string;
  note: string;
}

export interface CatalogItem {
  id: string;
  kind: CatalogKind;
  title: string;
  summary: string;
  description: string;
  params?: CatalogParam[];
  provider?: string;
  cadence?: string;
  endpoint?: string;
  tables?: string[];
  tools?: string[];
  feeds?: string[];
  live?: 'econ' | 'news' | 'search' | 'sql';
}

export const OVERVIEW_ID = 'overview';
export const QUERY_ID = 'query';

export const OVERVIEW: CatalogItem = {
  id: OVERVIEW_ID,
  kind: 'overview',
  title: 'What Chat can use',
  summary: 'Tools, live APIs, and lake tables that can land in an answer',
  description:
    'Every Chat answer is grounded in this catalog. The model writes SQL against the Iceberg lake, calls live APIs for headlines and the macro calendar, and can chart the rows it just fetched. Browse a source here to see what it contains, which tool reads it, and — for lake tables — query it yourself.',
};

export const QUERY: CatalogItem = {
  id: QUERY_ID,
  kind: 'query',
  title: 'Query the lake',
  summary: 'Read-only DataFusion SQL against options.*',
  description:
    'The same surface Chat uses via run_query. Only SELECT / WITH / DESCRIBE / SHOW / EXPLAIN are allowed. Click a lake table to preview it, or paste SQL and run with Ctrl/Cmd+Enter.',
  endpoint: 'POST /api/query',
  tools: ['run_query', 'check_schema'],
  live: 'sql',
};

export const TOOLS: CatalogItem[] = [
  {
    id: 'tool:run_query',
    kind: 'tool',
    title: 'run_query',
    summary: 'Execute read-only SQL against the options lake',
    description:
      'Chat’s primary tool. It validates identifiers against the live schema, runs one SELECT/WITH on the Iceberg lake, and can cache up to 5,000 rows as a named frame for follow-up filters. This is how screens, smiles, surfaces, earnings joins, and IV history reach the answer.',
    endpoint: 'POST /api/query',
    params: [
      { name: 'sql', type: 'string', note: 'Read-only DataFusion SQL; must end with LIMIT' },
      { name: 'save_as', type: 'string?', note: 'Optional frame name to cache the result for this chat' },
    ],
    tools: ['check_schema', 'filter_frame', 'render_chart'],
    live: 'sql',
  },
  {
    id: 'tool:check_schema',
    kind: 'tool',
    title: 'check_schema',
    summary: 'Validate SQL against real table and column names',
    description:
      'Dry-run schema check used before or instead of executing SQL. Rejects invented identifiers so Chat does not guess column names.',
    endpoint: 'GET /api/tables',
    params: [{ name: 'sql', type: 'string', note: 'Proposed SQL to validate' }],
  },
  {
    id: 'tool:list_frames',
    kind: 'tool',
    title: 'list_frames',
    summary: 'List cached result frames for this chat',
    description:
      'Frames are per-chat snapshots of a query result (columns, row counts, value sketches). They expire after 15 minutes. Chat uses them so a smile or chain follow-up does not re-scan the lake.',
  },
  {
    id: 'tool:filter_frame',
    kind: 'tool',
    title: 'filter_frame',
    summary: 'Slice a cached frame without hitting the lake',
    description:
      'Filter, sort, project, and limit a named frame with expressions over column names (==, !=, <, &&, abs, round, …). Used for “just the 30-delta calls” after a chain was already fetched.',
    params: [
      { name: 'frame', type: 'string', note: 'Cached frame name' },
      { name: 'where', type: 'string?', note: 'Expression over column names' },
      { name: 'sort', type: 'string?', note: 'Sort expression' },
      { name: 'limit', type: 'number?', note: 'Max rows to keep' },
      { name: 'project', type: 'string[]?', note: 'Columns to keep' },
      { name: 'save_as', type: 'string?', note: 'Optional new frame name' },
    ],
  },
  {
    id: 'tool:refresh_frame',
    kind: 'tool',
    title: 'refresh_frame',
    summary: 'Re-run a stale frame’s source SQL',
    description: 'Frames go stale after 15 minutes. This re-executes the original query and replaces the cached rows.',
    params: [{ name: 'frame', type: 'string', note: 'Frame to refresh' }],
    tools: ['run_query'],
  },
  {
    id: 'tool:render_chart',
    kind: 'tool',
    title: 'render_chart',
    summary: 'Attach a chart spec to the latest result',
    description:
      'The UI only draws a chart from this tool. After run_query or filter_frame, Chat specifies kind (line/area/scatter/bar) plus x, y, and optional series. A vol smile is typically x=strike, y=implied_vol, series=type.',
    params: [
      { name: 'kind', type: 'line | area | scatter | bar', note: 'Chart type' },
      { name: 'x', type: 'string', note: 'Column for the x axis' },
      { name: 'y', type: 'string', note: 'Column for the y axis' },
      { name: 'series', type: 'string?', note: 'Optional series / color split' },
    ],
  },
  {
    id: 'tool:get_news',
    kind: 'tool',
    title: 'get_news',
    summary: 'Recent headlines for one ticker',
    description:
      'Used when explaining why a name, option volume, or implied vol moved. Proxies Tavily news search through the Worker and returns citable title + link rows.',
    endpoint: 'GET /api/news',
    feeds: ['tavily-news'],
    params: [
      { name: 'symbol', type: 'string', note: 'Ticker, e.g. NVDA' },
      { name: 'limit', type: 'number', note: '1–20 headlines (default 8)' },
    ],
    live: 'news',
  },
  {
    id: 'tool:research_ticker',
    kind: 'tool',
    title: 'research_ticker',
    summary: 'Lake + D1 ticker research brief',
    description:
      'Required when suggesting a trade or deep-diving one underlying. Resolves the ticker from D1/lake (ticker-seeded security_id), links the chat to that security, and returns a cached brief: recent price/volume moves, consolidation/accumulation, lake fundamentals (market cap, PE, debt from options.fundamentals, latest-wins), earnings, and (for ETFs) fund profile + top holdings from options.etf_profiles / etf_holdings. GET /api/research/{ticker} does not call OpenFIGI, Tavily, or live Yahoo — headlines load separately via get_news / /api/news. Powers chat ticker chips (→ /research/{ticker}) and the ticker detail page.',
    endpoint: 'GET /api/research/{ticker}',
    feeds: ['yahoo'],
    tables: ['ohlc', 'realized_vol', 'earnings', 'securities', 'fundamentals'],
    params: [
      { name: 'symbol', type: 'string', note: 'Ticker to normalize and research' },
      { name: 'force', type: 'boolean?', note: 'Bypass the 1h D1 research cache' },
    ],
    tools: ['suggest_trades'],
  },
  {
    id: 'tool:suggest_trades',
    kind: 'tool',
    title: 'suggest_trades',
    summary: 'Structured end-of-turn trade ideas',
    description:
      'Publishes 0–3 typed trade suggestions (ticker, bias, conviction, structure, optional legs, rationale, liquidity) after the desk. Legs are formal: instrument option|equity, side buy|sell (long/short), optional qty, plus option right/strike/expiry. The chat UI renders these rows from the tool payload — it does not parse freeform markdown. Empty trades[] with skip_reason covers thin books. Absolute strikes must come from option_contracts quote evidence.',
    tables: ['option_contracts'],
    tools: ['research_ticker', 'run_query', 'publish_desk'],
    params: [
      { name: 'trades', type: 'array', note: '0–3 structured trade ideas' },
      { name: 'skip_reason', type: 'string?', note: 'Optional when trades is empty (worker defaults)' },
    ],
  },
  {
    id: 'tool:web_search',
    kind: 'tool',
    title: 'web_search',
    summary: 'Open web search for commentary and events',
    description:
      'General Tavily search (not pinned to news-topic or a recency window). Chat uses it for analyst notes, “what are people saying?”, and events that are not in the per-ticker news feed. Returns up to five citable links.',
    endpoint: 'GET /api/web_search',
    feeds: ['tavily-search'],
    params: [
      { name: 'query', type: 'string', note: 'Search string, max 200 chars' },
      { name: 'max_results', type: 'number', note: '1–5 results (default 5)' },
    ],
    live: 'search',
  },
  {
    id: 'tool:eco_calendar',
    kind: 'tool',
    title: 'eco_calendar',
    summary: 'Upcoming macro and FOMC dates',
    description:
      'Scheduled high-impact releases for the next 7–90 days. Reads options.econ_calendar (FRED + Fed) with a live-fetch fallback. Chat must call this for Fed meetings, CPI/jobs/GDP weeks, and broad event-vol questions even if it also queries the lake table.',
    endpoint: 'GET /api/econ_calendar',
    feeds: ['fred', 'federalreserve'],
    tables: ['econ_calendar'],
    params: [{ name: 'days', type: 'number', note: 'Window 7–90 (default 30)' }],
    live: 'econ',
  },
];

export const FEEDS: CatalogItem[] = [
  {
    id: 'feed:cboe',
    kind: 'feed',
    title: 'CBOE delayed quotes',
    summary: 'Official exchange options + Greeks, ~15 min delayed',
    description:
      'The core market feed. The loader fetches delayed chains from cdn.cboe.com (no API key), OCC-normalizes them, and publishes contracts plus underlying snapshots on a ~15 minute cadence during US market hours. Chat answers about volume, open interest, IV, and Greeks come from this feed.',
    provider: 'CBOE',
    cadence: '~15 min during US market hours',
    tables: ['option_contracts', 'underlying_snapshots', 'refresh_runs'],
    tools: ['run_query'],
  },
  {
    id: 'feed:fred',
    kind: 'feed',
    title: 'FRED macro calendar',
    summary: 'CPI, PPI, Employment Situation, GDP, PCE, Michigan',
    description:
      'St. Louis Fed release dates for a curated high-impact set: Consumer Price Index, Producer Price Index, Employment Situation, Personal Income and Outlays, Gross Domestic Product, and Surveys of Consumers. Loaded daily into options.econ_calendar; the eco_calendar tool also live-fetches as fallback. FOMC placeholders are ignored here — those come from the Fed calendar.',
    provider: 'FRED (St. Louis Fed)',
    cadence: 'Daily (ungated)',
    endpoint: 'GET /api/econ_calendar',
    tables: ['econ_calendar'],
    tools: ['eco_calendar', 'run_query'],
    live: 'econ',
  },
  {
    id: 'feed:fred-yields',
    kind: 'feed',
    title: 'FRED Treasury / rates curve',
    summary: 'Constant-maturity yields, spreads, TIPS, SOFR',
    description:
      'Daily FRED series observations (~10y lookback) into options.yields: DGS1MO–DGS30 constant-maturity Treasuries, T10Y2Y / T10Y3M curve spreads, T5YIE / T10YIE breakevens, DFII5 / DFII10 TIPS, plus DFF and SOFR overnight policy rates. Values are percent / percentage points. Bond ETF prices (TLT, IEF, SHY) remain in options.ohlc — this table is the actual yield curve levels everything else is priced off of.',
    provider: 'FRED (St. Louis Fed)',
    cadence: 'Daily (fred-yields-daily job)',
    tables: ['yields'],
    tools: ['run_query', 'render_chart'],
  },
  {
    id: 'feed:federalreserve',
    kind: 'feed',
    title: 'Federal Reserve calendar',
    summary: 'FOMC meetings and Beige Book dates',
    description:
      'Keyless Fed calendar JSON for FOMC and Beige Book events (decision-day dates plus ET release times). FRED emits daily placeholders for unscheduled press releases, so FOMC dates are sourced here instead. Historical rows support event-impact joins against options.ohlc.',
    provider: 'Board of Governors of the Federal Reserve',
    cadence: 'Daily with the FRED job',
    endpoint: 'GET /api/econ_calendar',
    tables: ['econ_calendar'],
    tools: ['eco_calendar', 'run_query'],
    live: 'econ',
  },
  {
    id: 'feed:tavily-news',
    kind: 'feed',
    title: 'Tavily news',
    summary: 'Per-ticker headlines for why-is-it-moving questions',
    description:
      'Worker proxy to Tavily’s news search. Chat calls get_news with a ticker; the API returns recent headlines with titles, links, and snippets. Used after implied-vs-realized vol and earnings, when the question is about a move.',
    provider: 'Tavily',
    cadence: 'On demand (cached ~briefly)',
    endpoint: 'GET /api/news',
    tools: ['get_news', 'research_ticker'],
    live: 'news',
  },
  {
    id: 'feed:tavily-search',
    kind: 'feed',
    title: 'Tavily web search',
    summary: 'Open search for commentary beyond the ticker news feed',
    description:
      'Same provider as news, without the news-topic pin or recency window. Chat uses web_search for analyst notes, “what happened?”, and events that are not ticker-specific.',
    provider: 'Tavily',
    cadence: 'On demand',
    endpoint: 'GET /api/web_search',
    tools: ['web_search'],
    live: 'search',
  },
  {
    id: 'feed:yahoo',
    kind: 'feed',
    title: 'Yahoo Finance OHLC',
    summary: 'Daily bars, realized vol, dividends and splits',
    description:
      'Daily OHLC (~1 year) plus dividend/split events for equities and ETFs. Realized volatility is computed off split-adjusted closes (30d / 90d, annualized). Chat compares implied vol from CBOE chains against this realized series on why-is-it-moving questions. Continuous futures (=F), CBOE vol indexes (^VIX, …), and spot crypto (BTC-USD, …) reuse the same options.ohlc / realized_vol tables via futures-ohlc-daily, indices-ohlc-daily, and crypto-spot-ohlc-daily.',
    provider: 'Yahoo Finance',
    cadence: 'Daily (ungated) + on-demand backfill',
    tables: ['ohlc', 'realized_vol', 'corporate_actions'],
    tools: ['run_query', 'research_ticker'],
  },
  {
    id: 'feed:yahoo-etf',
    kind: 'feed',
    title: 'Yahoo ETF profiles',
    summary: 'Expense ratio, AUM, yield, and top-10 holdings',
    description:
      'Daily fund profile plus top holdings for the optionable ETF sleeve of the universe (including VIX ETPs such as VXX, UVXY, SVXY and crypto ETFs such as IBIT, ETHA, SOLZ). Chat uses this for “what’s inside SPY?”, expense-ratio screens, and AUM/yield context next to the option chain.',
    provider: 'Yahoo Finance',
    cadence: 'Daily (etf-daily job)',
    tables: ['etf_profiles', 'etf_holdings'],
    tools: ['run_query'],
  },
  {
    id: 'feed:yahoo-indices',
    kind: 'feed',
    title: 'Yahoo CBOE vol indexes',
    summary: '^VIX spot history and sibling vol indexes',
    description:
      'Daily OHLC for CBOE volatility indexes (^VIX, ^VVIX, ^VIX9D, ^VIX3M, ^SKEW, ^VXN) from symbols/indices.json via indices-ohlc-daily. Lands in options.ohlc / options.realized_vol alongside equities. VX futures term structure is separate (cfe-futures-daily).',
    provider: 'Yahoo Finance',
    cadence: 'Daily (indices-ohlc-daily job)',
    tables: ['ohlc', 'realized_vol'],
    tools: ['run_query'],
  },
  {
    id: 'feed:yahoo-crypto',
    kind: 'feed',
    title: 'Yahoo spot cryptocurrencies',
    summary: 'BTC-USD and other major spot crypto OHLC',
    description:
      'Daily OHLC for major spot cryptocurrencies (BTC-USD, ETH-USD, SOL-USD, XRP-USD, …) from symbols/crypto-spot.json via crypto-spot-ohlc-daily. Lands in options.ohlc / options.realized_vol alongside equities. Crypto ETFs with CBOE option chains (IBIT, ETHA, …) are in the equity/ETF universe; CME continuous futures (BTC=F, ETH=F, MBT=F, MET=F) stay on futures-ohlc-daily.',
    provider: 'Yahoo Finance',
    cadence: 'Daily (crypto-spot-ohlc-daily job)',
    tables: ['ohlc', 'realized_vol'],
    tools: ['run_query', 'research_ticker'],
  },
  {
    id: 'feed:cfe-futures',
    kind: 'feed',
    title: 'Cboe Futures Exchange (CFE)',
    summary: 'VX settlements and delayed monthals',
    description:
      'Official daily settlement CSV plus delayed monthals for CFE products (VX curve and siblings). Lands in options.futures_settlements and options.futures_quotes. Complements ^VIX spot (indices-ohlc-daily) and VIX ETPs in the equity/ETF universe.',
    provider: 'CBOE',
    cadence: 'Daily (cfe-futures-daily job)',
    tables: ['futures_settlements', 'futures_quotes'],
    tools: ['run_query'],
  },
  {
    id: 'feed:yahoo-fundamentals',
    kind: 'feed',
    title: 'Yahoo equity fundamentals',
    summary: 'Market cap, P/E, debt, margins for research',
    description:
      'Daily quoteSummary fundamentals for the equity sleeve (S&P 500 + Nasdaq-100 delta). Powers the ticker detail strip and research_ticker — market cap, trailing/forward P/E, debt, D/E, profit margins — from options.fundamentals (latest-wins by ticker), not a live Yahoo scrape.',
    provider: 'Yahoo Finance',
    cadence: 'Daily (fundamentals-daily job)',
    tables: ['fundamentals'],
    tools: ['run_query', 'research_ticker'],
  },
  {
    id: 'feed:nasdaq',
    kind: 'feed',
    title: 'Nasdaq earnings calendar',
    summary: 'Upcoming earnings dates, BMO/AMC, EPS estimates',
    description:
      'Nasdaq earnings calendar for the S&P 500 window, published to options.earnings. Chat joins this to chains when event vol or “why is IV rich?” might be an earnings print.',
    provider: 'Nasdaq',
    cadence: 'Daily (ungated)',
    tables: ['earnings'],
    tools: ['run_query', 'research_ticker'],
  },
  {
    id: 'feed:edgar',
    kind: 'feed',
    title: 'SEC EDGAR filings',
    summary: 'Equity 10-K/Q/8-K and ETF prospectuses',
    description:
      'Daily SEC submissions ingest for the equity + ETF universe. Equities land 10-K / 10-Q / 8-K rows; ETFs land the prospectus family (N-1A, 485BPOS, 497, …). Metadata + edgar_url go to options.sec_filings (append-only historical). Research links out to the primary document on sec.gov.',
    provider: 'SEC EDGAR',
    cadence: 'Daily (sec-filings-daily job)',
    tables: ['sec_filings'],
    tools: ['run_query'],
    endpoint: 'GET /api/research/{ticker}/filings',
  },
  {
    id: 'feed:openfigi',
    kind: 'feed',
    title: 'OpenFIGI identifiers',
    summary: 'FIGI / composite FIGI / ISIN on the security master',
    description:
      'Bloomberg OpenFIGI mapping for the universe manifest. Lands on options.securities (and ticker validity on options.symbol_history) so Chat can resolve names, sectors, and identifier history — not just the live CBOE ticker.',
    provider: 'OpenFIGI',
    cadence: 'With securities / symbology loads + live Worker resolve',
    tables: ['securities', 'symbol_history'],
    tools: ['run_query', 'research_ticker'],
  },
  {
    id: 'feed:instruments',
    kind: 'feed',
    title: 'Instrument classification',
    summary: 'security_type tags for every OHLC symbol',
    description:
      'Latest-wins dimension for the full OHLC universe: equity, etf, index, future, crypto (extendable). Built from loader manifests plus enrolled tickers via instruments-daily — join options.instruments on symbol instead of hand-listing ETF tickers. Optional asset_class (Broad Market, US Sector, Crypto, …) for finer screens.',
    provider: 'Loader manifests',
    cadence: 'Daily (instruments-daily job)',
    tables: ['instruments'],
    tools: ['run_query'],
  },
];

export const TABLE_META: Record<string, Pick<CatalogItem, 'summary' | 'description' | 'feeds' | 'tools'>> = {
  option_contracts: {
    summary: 'CBOE option chains — quotes, sizes, IV, Greeks',
    description:
      'One row per contract from the latest CBOE delayed snapshot: bid/ask/size, volume, open interest, implied vol (decimal, 0.25 = 25%), and CBOE Black-Scholes Greeks. Chat’s screens, smiles, and surfaces start here.',
    feeds: ['cboe'],
    tools: ['run_query', 'render_chart'],
  },
  underlying_snapshots: {
    summary: 'Latest spot, name, and sector per ticker',
    description:
      'Per-refresh underlying snapshot: spot_price, name, and sector denormalized from the universe manifest. The OCC root column is `ticker` (not `symbol`). Join to option_contracts with underlying_snapshots.ticker = option_contracts.symbol.',
    feeds: ['cboe'],
    tools: ['run_query'],
  },
  refresh_runs: {
    summary: 'Loader pass history and contract counts',
    description:
      'Each CBOE refresh records expected vs successful symbols, contract count, status, and timestamps. The monitor reads this; Chat can too when asked whether the lake is fresh.',
    feeds: ['cboe'],
    tools: ['run_query'],
  },
  ohlc: {
    summary: 'Yahoo daily OHLC bars (~1 year)',
    description:
      'Daily open/high/low/close/volume per symbol — equities, ETFs, continuous futures (=F), and CBOE vol indexes (^VIX, …). Newest run wins per date. Used for spot history and as the input to realized vol.',
    feeds: ['yahoo', 'yahoo-indices'],
    tools: ['run_query', 'render_chart'],
  },
  realized_vol: {
    summary: '30-day and 90-day annualized realized vol',
    description:
      'Computed from split-adjusted Yahoo closes. Chat compares this to implied_vol on option_contracts for rich/cheap vol questions.',
    feeds: ['yahoo', 'yahoo-indices'],
    tools: ['run_query'],
  },
  corporate_actions: {
    summary: 'Dividends and splits',
    description:
      'Yahoo dividend and split events (action_type DIVIDEND or SPLIT, ex_date, cash amount or split ratio). Relevant for corporate-action vol and adjusted-history questions.',
    feeds: ['yahoo'],
    tools: ['run_query'],
  },
  securities: {
    summary: 'Security master — name, sector, FIGI, ISIN',
    description:
      'Descriptive facts for each ticker in the universe: name, sector, exchange, currency, figi, composite_figi, isin. CBOE does not supply name/sector; those are merged from the manifest plus OpenFIGI.',
    feeds: ['openfigi', 'cboe'],
    tools: ['run_query'],
  },
  instruments: {
    summary: 'Instrument kind — equity / etf / index / future / crypto',
    description:
      'One latest-wins row per symbol with security_type (extendable string), optional asset_class, and source. Covers equities, ETFs, indexes, continuous futures, and spot crypto. Join to options.ohlc on symbol for type filters (e.g. WHERE security_type = \'etf\') instead of hand-listing tickers.',
    feeds: ['instruments'],
    tools: ['run_query'],
  },
  symbol_history: {
    summary: 'Ticker identity over time',
    description:
      'valid_from / valid_to / is_current rows so a rename does not orphan historical OHLC or corporate actions.',
    feeds: ['openfigi'],
    tools: ['run_query'],
  },
  etf_profiles: {
    summary: 'ETF expense ratio, AUM, yield, and fund family',
    description:
      'One row per ETF: family, category, asset class, expense_ratio, net_assets, trailing_yield, inception_date. Newest run wins per ticker. Join to option_contracts on ticker/symbol for ETF-vs-single-stock screens.',
    feeds: ['yahoo-etf'],
    tools: ['run_query'],
  },
  etf_holdings: {
    summary: 'Top holdings and weights per ETF',
    description:
      'Ranked constituents (holding_symbol, holding_name, weight) for each ETF. Chat joins this to chains when concentration or “what does QQQ hold?” is part of the question.',
    feeds: ['yahoo-etf'],
    tools: ['run_query'],
  },
  fundamentals: {
    summary: 'Equity market cap, P/E, debt, and margins',
    description:
      'One row per equity per loader pass: market_cap, enterprise_value, trailing/forward P/E, peg_ratio, price_to_book, total_debt, debt_to_equity, profit_margins, revenue_growth. Newest run wins per ticker. Feeds research_ticker and /research/{ticker}.',
    feeds: ['yahoo-fundamentals'],
    tools: ['run_query', 'research_ticker'],
  },
  earnings: {
    summary: 'Nasdaq earnings dates and EPS estimates',
    description:
      'Upcoming and recent earnings: earnings_date, time (BMO/AMC), fiscal quarter, eps_forecast, last_year_eps. Chat joins this to chains for event-vol questions.',
    feeds: ['nasdaq'],
    tools: ['run_query'],
  },
  sec_filings: {
    summary: 'SEC filings and ETF prospectuses',
    description:
      'EDGAR metadata rows: form_type, accession, filed_at, report_date, kind (filing|prospectus), edgar_url. Equities keep 10-K/10-Q/8-K; ETFs keep N-1A / 485BPOS / 497 family. Append-only — newest run wins per accession. Powers /research/{ticker} filings links.',
    feeds: ['edgar'],
    tools: ['run_query'],
  },
  econ_calendar: {
    summary: 'FRED macro releases + FOMC / Beige Book',
    description:
      'event_date, title, kind (macro|fed), source (fred|federalreserve), optional event_time ET. The eco_calendar tool prefers this table and falls back to a live FRED/Fed fetch.',
    feeds: ['fred', 'federalreserve'],
    tools: ['eco_calendar', 'run_query'],
  },
  yields: {
    summary: 'US Treasury / rates curve (FRED)',
    description:
      'series_id, date, value (percent / percentage points), title, tenor, kind (nominal|real|breakeven|spread|policy), source=fred. Constant-maturity DGS* curve, T10Y2Y/T10Y3M spreads, TIPS/breakevens, DFF/SOFR. ~10y of daily history; latest-wins on (series_id, date). Prefer this over bond ETF closes when the question is about the yield curve.',
    feeds: ['fred-yields'],
    tools: ['run_query', 'render_chart'],
  },
  futures_settlements: {
    summary: 'CFE daily settlement prices (VX curve)',
    description:
      'Official Cboe Futures Exchange settlement CSV rows: product, contract_symbol, expiration_date, settle_price. Includes VX monthals and weeklies. Join to futures_quotes on contract_symbol for the live delayed book.',
    feeds: ['cfe-futures'],
    tools: ['run_query'],
  },
  futures_quotes: {
    summary: 'CFE delayed monthals (bid/ask/OI)',
    description:
      'Delayed quotes for CFE monthals (e.g. VXU26): last, bid/ask, OHLC, volume, open interest, settlement_price. Derived from monthly settlement symbols; weeklies that 403 are skipped.',
    feeds: ['cfe-futures'],
    tools: ['run_query'],
  },
};

export function tableItem(name: string): CatalogItem {
  const meta = TABLE_META[name];
  return {
    id: `table:${name}`,
    kind: 'table',
    title: name,
    summary: meta?.summary ?? 'Iceberg table in the options lake',
    description:
      meta?.description ??
      `Read-only lake table options.${name}. Chat queries it with run_query.`,
    tables: [name],
    tools: meta?.tools ?? ['run_query', 'check_schema'],
    feeds: meta?.feeds,
    live: 'sql',
  };
}

const BY_ID: Map<string, CatalogItem> = new Map(
  [OVERVIEW, QUERY, ...TOOLS, ...FEEDS].map((item) => [item.id, item]),
);

export function catalogItem(id: string): CatalogItem | undefined {
  if (BY_ID.has(id)) return BY_ID.get(id);
  if (id.startsWith('table:')) return tableItem(id.slice('table:'.length));
  return undefined;
}

export function itemMatches(item: CatalogItem, needle: string): boolean {
  if (!needle) return true;
  const hay = [
    item.title,
    item.summary,
    item.description,
    item.provider,
    item.endpoint,
    ...(item.tables ?? []),
    ...(item.tools ?? []),
    ...(item.feeds ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}
