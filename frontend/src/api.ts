export interface Stats {
  underlyings: number;
  contracts: number;
  calls: number;
  puts: number;
  last_updated: string;
}
export interface Underlying {
  symbol: string;
  name: string;
  sector: string;
  spot: number | null;
  contracts: number;
}

export interface OptionRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  spot: number | null;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  in_the_money: boolean | null;
  // CBOE-delivered columns (hard cutover from Yahoo): theoretical price +
  // quoted bid/ask sizes. Optional so callers that don't select them still typecheck.
  theo?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
  moneyness_pct: number | null;
}

export interface ScreenResponse {
  total: number;
  items: OptionRow[];
  truncated?: boolean;
}

export interface RefreshRun {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  as_of_date: string;
  expected_symbols: number;
  successful_symbols: number;
  failed_symbols: number;
  contract_count: number;
  status: string;
  error_summary: string | null;
}

export interface SymbolSuggestion {
  symbol: string;
  name: string | null;
  sector: string | null;
}

export interface SectorRow {
  sector: string;
  symbols: number;
  avg_spot: number | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  row_count: number | null;
  columns: ColumnInfo[];
  /** Up to 3 sample rows from the (D1-cached) lake schema; absent when the fetch predates samples. */
  sample?: Record<string, unknown>[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
  limit?: number;
  error?: string;
}


export interface ChainContract {
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  in_the_money: boolean | null;
  // CBOE-delivered columns (see OptionRow).
  theo?: number | null;
  bid_size?: number | null;
  ask_size?: number | null;
}

/** One spot OHLC bar (daily lake bar, or intraday Yahoo 5m with date as YYYY-MM-DDTHH:MM). */
export interface OhlcBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

/** Latest realized-volatility snapshot (options.realized_vol), annualized fractions. */
export interface RealizedVol {
  as_of_date: string;
  realized_vol_30d: number | null;
  realized_vol_90d: number | null;
  n_returns_30: number | null;
  n_returns_90: number | null;
}

/** Latest dividend/split row for an underlying (options.corporate_actions). */
export interface CorporateAction {
  action_type: 'DIVIDEND' | 'SPLIT';
  ex_date: string; // YYYY-MM-DD
  numerator: number | null; // split ratio, e.g. 4-for-1
  denominator: number | null;
  amount: number | null; // per-share cash dividend
}

/** One headline from the Worker's /api/news proxy (Tavily news search). */
export interface NewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: 'tavily';
}

/** Response of /api/news — degrades to an empty item list with `error` on upstream failure. */
export interface NewsResponse {
  symbol: string;
  items: NewsItem[];
  source?: 'tavily';
  error?: string;
  fetched_at: string;
}

/** One SEC EDGAR filing / ETF prospectus from /api/research/{ticker}/filings. */
export interface SecFilingItem {
  form_type: string;
  accession: string;
  filed_at: string;
  report_date: string | null;
  description: string | null;
  edgar_url: string;
  kind: 'filing' | 'prospectus' | string;
}

/** Response of /api/research/{ticker}/filings — empty when lake table missing. */
export interface SecFilingsResponse {
  ticker: string;
  items: SecFilingItem[];
  count: number;
}

/** One result from the Worker's /api/web_search proxy (Tavily general search). */
export interface WebSearchResult {
  title: string;
  link: string;
  snippet: string;
  source: string | null;
}

/** Response of /api/web_search — degrades to an empty result list with `error` on upstream failure. */
export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  error?: string;
  fetched_at: string;
}

/** One scheduled macro/FOMC event from /api/econ_calendar. */
export interface EconCalendarEvent {
  date: string;
  title: string;
  kind: 'macro' | 'fed';
  time?: string; // "HH:MM" ET (24h) — present for FOMC/Beige (Fed calendar)
}

/** Response of /api/econ_calendar — degrades to `items: []` + `error`. */
export interface EconCalendarResponse {
  window_days: number;
  as_of: string;
  provider: 'fred' | 'federalreserve';
  items: EconCalendarEvent[];
  error?: string;
}

/** One daily ATM-IV point for /api/iv_rank (deduped per fetched_at date). */
export interface IvRankPoint {
  d: string;
  iv: number | null;
}

/** Response of /api/iv_rank — IV percentile vs a symbol's own history. */
export interface IvRankResponse {
  symbol: string;
  days: number;
  points: IvRankPoint[];
  rank_pct: number | null;
  iv_now: number | null;
  iv_median: number | null;
  iv_min: number | null;
  iv_max: number | null;
  as_of: string | null;
  error?: string;
}

export interface EtfProfile {
  ticker: string;
  name: string | null;
  family: string | null;
  category: string | null;
  asset_class: string | null;
  expense_ratio: number | null;
  net_expense_ratio: number | null;
  net_assets: number | null;
  trailing_yield: number | null;
  inception_date: string | null;
}

export interface EtfHolding {
  rank: number | null;
  holding_symbol: string | null;
  holding_name: string | null;
  weight: number | null;
}

export interface SymbolDetail {
  underlying: {
    symbol: string;
    name: string | null;
    sector: string | null;
    spot: number | null;
    fetched_at: string | null;
  } | null;
  contracts: ChainContract[];
  expirations: string[];
  n_contracts: number;
  // Enrichment from the OHLC pipeline (~1y of daily bars, latest realized-vol
  // snapshot, recent dividends/splits). Optional: older worker deploys omit
  // them; empty arrays when the tables have no rows for this symbol.
  ohlc?: OhlcBar[];
  realized_vol?: RealizedVol | null;
  corporate_actions?: CorporateAction[];
  etf_profile?: EtfProfile | null;
  etf_holdings?: EtfHolding[];
}

export interface PremiumNotebookRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  spot: number | null;
  expiration: string;
  type: 'call' | 'put';
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  open_interest: number | null;
  implied_vol: number | null;
  delta: number | null;
  in_the_money: boolean | null;
  premium: number | null;
  moneyness: number | null;
  premium_ratio: number | null;
}

export interface PremiumNotebook {
  notebook: string;
  target_dte: number;
  tolerance: number;
  moneyness_band: number;
  min_volume: number;
  calls: PremiumNotebookRow[];
  puts: PremiumNotebookRow[];
}

// ---------------------------------------------------------------------------
// Continuous loader live state (via the /loader/* screener pass-through).
// Timestamps are epoch-ms D1 INTEGERs; null when never recorded.
// ---------------------------------------------------------------------------
export interface LoaderStatus {
  ok: boolean;
  driver: string;
  counts: { total: number; enabled: number; due: number; failing: number };
  last_pass: {
    at: number;
    finished_at: number;
    run_id: string | null;
    attempted: number;
    succeeded: number;
    failed: number;
    batch: string[];
    transport_error: string | null;
    duration_ms: number;
  } | null;
  next_alarm: number | null;
  passing: boolean;
  market?: {
    open: boolean;
    reason?: 'open' | 'overnight' | 'after-hours' | 'weekend' | 'holiday';
    now_et?: string | null;
    next_open_et?: string | null;
  };
}

export type LoaderFilter = 'all' | 'failing' | 'retrying' | 'stale' | 'disabled';

export interface LoaderSymbol {
  symbol: string;
  enabled: number;
  last_success_at: number | null;
  last_attempt_at: number | null;
  consecutive_failures: number;
  next_attempt_after: number;
  backoff_seconds: number;
  last_error: string | null;
}

export interface LoaderSymbolsResponse {
  ok: boolean;
  total: number;
  items: LoaderSymbol[];
}

// ---------------------------------------------------------------------------
// API client — fetches the screener-api Cloudflare Worker (R2 SQL backend).
// The exported types above are unchanged from the in-browser DuckDB-WASM era,
// so the UI components need no edits. `VITE_API_BASE` (frontend/.env) points at
// the deployed Worker URL; in local dev it can point at `http://127.0.0.1:8787`
// or be left empty to use the Vite `/api` proxy.
// ---------------------------------------------------------------------------
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';


// ---------------------------------------------------------------------------
// Copilot chat history (Worker POST /api/chat/history → options.chat_history)
// ---------------------------------------------------------------------------
/** One message in a recorded transcript — stripped of bulky UI state (query result tables, chart specs, error stacks). */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
  /** Epoch ms when the message was produced. */
  ts?: number;
}

/** Body of POST /api/chat/history. The Worker adds server-side fields (ip, user_agent) and never trusts them from the client. */
export interface ChatHistoryRecord {
  /** Per-conversation id (stable across turns; one row per turn records the full conversation so far). */
  chat_id: string;
  /** Site-funded server-side Copilot. */
  mode: 'funded';
  model?: string;
  started_at: string;
  ended_at: string;
  messages: ChatHistoryMessage[];
}

/** Response of POST /api/chat/history — best-effort; `stored` is false when the pipeline is unavailable (buffered in D1). */
export interface ChatHistorySaveResponse {
  ok: boolean;
  stored: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Copilot chat shares (Worker POST /api/share/chat → D1 shared_chats)
// ---------------------------------------------------------------------------
/** Response of POST /api/share/chat — the share_id slug is the implicit capability (public, unlisted link). */
export interface ShareChatResponse {
  share_id: string;
  /** Canonical path — prefix with window.location.origin for the shareable URL. */
  url: string;
  /** True when the current session owns this share and has a public handle. */
  can_publish?: boolean;
  /** True when this share is listed on the public timeline. */
  on_timeline?: boolean;
  bot_handle?: string | null;
}

/**
 * One message in a shared transcript — ChatHistoryMessage plus the query
 * result / chart the live chat showed. Lake history still strips those;
 * shares keep a capped snapshot so a recipient can see the data.
 */
export interface SharedChatMessage extends ChatHistoryMessage {
  /** Model reasoning / thinking trace when the share captured it. */
  reasoning?: string;
  tools?: { name: string; args?: string; ok?: boolean; summary?: string }[];
  result?: QueryResult;
  chart?: {
    title?: string;
    kind: 'line' | 'area' | 'scatter' | 'bar';
    x: string;
    y: string;
    series?: string;
    xLabel?: string;
    yLabel?: string;
  };
  /** Three-analyst desk viewpoints published via publish_desk. */
  desk?: {
    fundamental: string;
    technical: string;
    options: string;
    overview: string;
  };
  /** Structured trade suggestions from suggest_trades (not prose-parsed). */
  trades?: {
    trades: {
      ticker: string;
      bias: 'bullish' | 'bearish' | 'neutral';
      conviction: 'high' | 'medium' | 'low';
      structure: string;
      legs?: {
        right: 'call' | 'put';
        side: 'buy' | 'sell';
        strike?: number;
        strike_rel?: string;
        expiration?: string;
        dte?: number;
      }[];
      rationale: string;
      liquidity?: string;
    }[];
    skip_reason?: string;
  };
}

export type ShareChatMessage = SharedChatMessage;

export interface ShareChatRecord extends Omit<ChatHistoryRecord, 'messages'> {
  messages: ShareChatMessage[];
  /** Admin-only: stamp this share as a bot timeline post. */
  bot_handle?: string;
  /** Admin bot session: link this share to a bot_runs row (idempotent per run). */
  run_id?: string;
}

/** Response of GET /api/share/:id — public, unlisted, read-only. No auth: the id is the key. */
export interface SharedChat {
  share_id: string;
  title: string | null;
  mode: 'funded';
  model: string | null;
  /** Epoch ms the share was created. */
  created_at: number;
  messages: SharedChatMessage[];
  /** The last assistant SQL, denormalized for a future alert-rerun feature. */
  source_sql: string | null;
  /** True when the author opted this share onto the public timeline. */
  on_timeline?: boolean;
  author?: { handle: string; name: string; is_bot?: boolean; persona?: string | null } | null;
  bot_handle?: string | null;
  bot?: { handle: string; display_name: string; persona: string } | null;
  /** NER / research_ticker tags linked via chat_tickers (may be empty). */
  tickers?: string[];
}

export interface TimelineAuthor {
  handle: string;
  name: string;
  is_bot?: boolean;
  persona?: string | null;
  bio?: string | null;
  /** Epoch ms when the public handle (or bot profile) was created. */
  created_at?: number | null;
  /** Relative Worker path (`/api/avatars/{user_id}`) when a custom photo is set. */
  avatar_url?: string | null;
}

export interface TimelinePost {
  share_id: string;
  url: string;
  title: string | null;
  excerpt: string;
  /**
   * Full slimmed conversation for in-feed reading (result rows omitted) —
   * includes sql / reasoning / chart on assistant turns when present.
   */
  messages: SharedChatMessage[];
  handle: string;
  name: string;
  /** Relative Worker path when the author has a custom photo; null for bots / default face. */
  avatar_url?: string | null;
  published_at: number;
  model: string | null;
  has_sql: boolean;
  has_chart: boolean;
  /** Tickers linked to the originating chat via chat_tickers (may be empty). */
  tickers?: string[];
  /** True when this post was generated by a bot profile. */
  is_bot?: boolean;
}

export interface BotProfile {
  handle: string;
  display_name: string;
  persona: string;
  bio: string | null;
  system_prompt_extra: string;
  seed_prompts: string[];
  model: string | null;
  reasoning_effort: string | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Admin directory row from GET /api/admin/users. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  email_verified: boolean;
  created_at: string;
  handle: string | null;
  display_name: string | null;
  public_name: string;
  avatar_url: string | null;
  profile_created_at: number | null;
  chat_count: number;
  is_admin: boolean;
}

/** Profile snippet nested on GET /api/admin/chat_history items. */
export interface AdminChatUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  handle: string | null;
  display_name: string | null;
  public_name: string;
  avatar_url: string | null;
  is_admin: boolean;
}

/** One conversation from GET /api/admin/chat_history (latest lake row per chat_id). */
export interface AdminChat {
  chat_id: string;
  mode: string;
  model: string | null;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  started_at: string;
  ended_at: string;
  source: string;
  fetched_at: string;
  messages: ChatHistoryMessage[] | null;
  title: string | null;
  message_count: number;
  visitor_fingerprint: string | null;
  user_agent_summary: string | null;
  user: AdminChatUser | null;
}

export interface AdminChatHistoryResponse {
  ok: boolean;
  limit: number;
  before: string | null;
  items: AdminChat[];
  next_before: string | null;
  as_of: string;
}

export interface BotRun {
  run_id: string;
  handle: string;
  chat_id: string;
  share_id: string | null;
  prompt: string;
  status: 'queued' | 'running' | 'shared' | 'failed';
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface BotSchedule {
  handle: string;
  enabled: boolean;
  cadence_seconds: number;
  market_gated: boolean;
  prompt: string;
  next_run_at: number;
  last_run_at: number | null;
  last_run_id: string | null;
  consecutive_failures: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CopilotPromptCapability {
  id: string;
  kind: 'system' | 'classifier' | 'meta' | 'invent' | 'addon';
  title: string;
  summary: string;
  body: string;
  used_by: string;
}

export interface CopilotToolCapability {
  name: string;
  label: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CopilotCapabilities {
  prompts: CopilotPromptCapability[];
  tools: CopilotToolCapability[];
  meta: {
    agent_iterations_max: number;
    query_force_failures_max: number;
    schema_mode: 'live' | 'placeholder';
    table_count: number;
    schema_include_samples: boolean;
  };
}

export interface BotGenerateResponse {
  ok: true;
  run_id: string;
  chat_id: string;
  prompt: string;
  /** How the prompt was chosen — unused requested text, unused seed, or LLM invent. */
  prompt_source?: 'requested' | 'seed' | 'invent';
  bot: {
    handle: string;
    display_name: string;
    persona: string;
    system_prompt_extra: string;
    model: string | null;
    reasoning_effort: string | null;
  };
  chat_url: string;
}

export interface TimelineFeed {
  items: TimelinePost[];
  next_before: number | null;
  profile: TimelineAuthor | null;
}

/** Desktop timeline rail — tags from public posts, breaking news, index tape. */
export interface TimelineRailTag {
  ticker: string;
  posts: number;
}

export interface TimelineRailNewsItem {
  title: string;
  link: string;
  published: string | null;
  snippet: string;
  source: 'tavily';
}

export interface TimelineRailHighlight {
  ticker: string;
  name: string;
  spot: number | null;
  change_1d_pct: number | null;
}

export interface TimelineRail {
  tags: TimelineRailTag[];
  news: TimelineRailNewsItem[];
  highlights: TimelineRailHighlight[];
  news_error?: string;
  highlights_error?: string;
  fetched_at: string;
}

export interface Health {
  ok: boolean;
  auth?: { google: boolean };
}

export interface ProfileMe {
  ok: true;
  id: string;
  /** Public display name — product override or Google name. */
  name: string;
  email: string;
  image: string | null;
  handle: string | null;
  /** Product display name; null means fall back to Google name. */
  display_name: string | null;
  /** Relative `/api/avatars/{id}` path when a custom photo is uploaded. */
  avatar_url: string | null;
  suggested_handle: string | null;
  /** True when the signed-in email is on the product admin allowlist. */
  is_admin: boolean;
}

export interface ProfileUpdate {
  ok: true;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  name: string;
}

/** @deprecated Prefer ProfileUpdate — kept for call sites that only read handle. */
export interface ProfileHandle {
  ok: true;
  handle: string;
}

export interface UserChat {
  chat_id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

/** Response of GET /api/chats/:id/transcript — owner-only DO backup from D1. */
export interface ChatTranscriptBackup {
  ok: boolean;
  chat_id: string;
  source: 'pending_history' | 'share' | null;
  title: string | null;
  messages: SharedChatMessage[];
}

export interface UserChatList {
  ok: boolean;
  items: UserChat[];
}

export interface UserChatClaim {
  ok: boolean;
  chat_id: string;
  title: string | null;
  created: boolean;
}

export interface TickerIdentity {
  security_id: string;
  ticker: string;
  figi: string | null;
  composite_figi: string | null;
  isin: string | null;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  sector: string | null;
  source: string;
  resolved_at: number;
}

export interface TickerResearch {
  identity: TickerIdentity;
  price: {
    spot: number | null;
    change_1d_pct: number | null;
    change_5d_pct: number | null;
    change_21d_pct: number | null;
    change_63d_pct: number | null;
    high_63d: number | null;
    low_63d: number | null;
    volume_latest: number | null;
    volume_avg_20d: number | null;
    volume_relative_20d: number | null;
  };
  technicals: {
    trend: string;
    consolidation: boolean;
    consolidation_range_pct: number | null;
    accumulation: string;
    notes: string[];
  };
  realized_vol: {
    as_of_date: string;
    realized_vol_30d: number | null;
    realized_vol_90d: number | null;
  } | null;
  fundamentals: {
    market_cap: number | null;
    enterprise_value: number | null;
    trailing_pe: number | null;
    forward_pe: number | null;
    peg_ratio: number | null;
    price_to_book: number | null;
    total_debt: number | null;
    debt_to_equity: number | null;
    profit_margins: number | null;
    revenue_growth: number | null;
    source: string | null;
  };
  /** FINRA short interest + Reg SHO short-volume ratio. Absent on older cache rows. */
  shorting?: {
    settlement_date: string | null;
    short_interest: number | null;
    short_interest_change_pct: number | null;
    days_to_cover: number | null;
    short_ratio: number | null;
    short_ratio_date: string | null;
    source: string | null;
  };
  earnings: Array<{
    earnings_date: string;
    time: string | null;
    fiscal_q: string | null;
    eps_forecast: number | null;
    last_year_eps: number | null;
    name: string | null;
  }>;
  news: Array<{ title: string; link: string }>;
  filings?: SecFilingItem[];
  etf: {
    name: string | null;
    family: string | null;
    category: string | null;
    asset_class?: string | null;
    net_assets: number | null;
    expense_ratio: number | null;
    net_expense_ratio?: number | null;
    trailing_yield?: number | null;
    inception_date?: string | null;
    /** Present on fresh briefs; older D1 cache rows may omit it. */
    holdings?: EtfHolding[];
  } | null;
  commentary?: string | null;
  commentary_source?: 'llm' | 'notes' | 'insufficient' | null;
  commentary_computed_at?: string | null;
  computed_at: string;
  expires_at: string;
  cache_hit: boolean;
}

export interface TickerCommentary {
  ticker: string;
  security_id: string;
  commentary: string;
  source: 'llm' | 'notes' | 'insufficient';
  computed_at: string;
  cache_hit: boolean;
}

export interface ChatTickerLink {
  chat_id: string;
  security_id: string;
  ticker: string;
  first_seen_at: number;
  last_seen_at: number;
  mention_count: number;
  name?: string | null;
  figi?: string | null;
  composite_figi?: string | null;
}

export interface ChatTickerList {
  chat_id: string;
  items: ChatTickerLink[];
}

export interface ResearchChatsResponse {
  ticker: string;
  security_id: string;
  items: ChatTickerLink[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + path, { credentials: 'include', ...init });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => r.statusText)}`);
  return r.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v))) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  /** No-op readiness: the Worker is always ready (was the DuckDB-WASM load gate). */
  ready: () => Promise.resolve(),
  health: () => get<Health>('/api/health'),
  stats: () => get<Stats>('/api/stats'),
  runs: (limit?: number) => get<RefreshRun[]>(`/api/runs${qs({ limit })}`),
  sectors: () => get<SectorRow[]>('/api/sectors'),
  symbols: (q: string) =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ q: q || undefined })}`),
  // Full symbol universe (names/sectors) for the cross-session typeahead cache;
  // the server caps at 1000 and the lake holds ~500 underlyings.
  symbolsAll: () =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ limit: 1000 })}`),
  screen: (params: Record<string, string | number | boolean | undefined>) =>
    get<ScreenResponse>(`/api/screen${qs(params)}`),
  // Lake schema, served from the Worker's D1 cache (recomputed when stale).
  // `force` skips the cache and recomputes live from the lake (Data catalog refresh).
  tables: (opts?: { force?: boolean }) =>
    get<TableInfo[]>(`/api/tables${qs({ force: opts?.force ? 1 : undefined })}`),
  query: (sql: string, limit?: number) => post<QueryResult>('/api/query', { sql, limit }),
  // Per-ticker news headlines (Worker → Tavily news search).
  news: (symbol: string, limit?: number) =>
    get<NewsResponse>(`/api/news${qs({ symbol: symbol.toUpperCase(), limit })}`),
  // Open web search (Worker → Tavily general search), for fresh analyst/market
  // commentary beyond the per-ticker news feed.
  webSearch: (q: string, limit?: number) =>
    get<WebSearchResponse>(`/api/web_search${qs({ q, limit })}`),
  // IV rank / percentile vs a symbol's own ATM-IV history (Worker lake query).
  ivRank: (symbol: string, days?: number) =>
    get<IvRankResponse>(`/api/iv_rank${qs({ symbol: symbol.toUpperCase(), days })}`),
  // Upcoming macro/FOMC event dates (Worker → FRED releases/dates, Fed calendar fallback).
  econCalendar: (days?: number) =>
    get<EconCalendarResponse>(`/api/econ_calendar${qs({ days })}`),
  symbolDetail: (symbol: string, opts?: {
    parts?: 'full' | 'ohlc' | 'ohlc_intraday' | 'chain';
    expiration?: string;
    near_spot?: number;
  }) =>
    get<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}${qs({
      parts: opts?.parts,
      expiration: opts?.expiration,
      near_spot: opts?.near_spot,
    })}`),
  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    limit?: number;
  }) => get<PremiumNotebook>(`/api/notebook/premium${qs(params)}`),
  loaderStatus: () => get<LoaderStatus>('/loader/status'),
  loaderSymbols: (params?: {
    filter?: LoaderFilter;
    q?: string;
    limit?: number;
    offset?: number;
    sort?: 'symbol' | 'last_success_at' | 'consecutive_failures';
    order?: 'asc' | 'desc';
  }) => get<LoaderSymbolsResponse>(`/loader/symbols${qs(params ?? {})}`),
  // Save a completed Copilot chat turn to the lake (options.chat_history).
  // Best-effort: the Worker buffers into D1 when the pipeline hiccups, and
  // failures are swallowed by the caller — a chat is never blocked by history
  // persistence. The table itself is admin-only (see /api/admin/chat_history).
  saveChatHistory: (record: ChatHistoryRecord) =>
    post<ChatHistorySaveResponse>('/api/chat/history', record),
  // Share the current conversation as a public unlisted link (D1
  // shared_chats). Unlike saveChatHistory this FAILS LOUDLY — the user
  // explicitly asked for the artifact, so errors surface for a retry.
  shareChat: (record: ShareChatRecord) =>
    post<ShareChatResponse>('/api/share/chat', record),
  // Fetch a public shared transcript. No auth; unknown/expired ids 404
  // identically. The share_id is high-entropy, so the URL is the capability.
  sharedChat: (shareId: string) =>
    get<SharedChat>(`/api/share/${encodeURIComponent(shareId)}`),
  timeline: (opts?: { handle?: string; before?: number; limit?: number }) =>
    request<TimelineFeed>(`/api/timeline${qs({ handle: opts?.handle, before: opts?.before, limit: opts?.limit })}`, {
      // Moderated feed — never reuse a cached list after publish/unpublish.
      cache: 'no-store',
    }),
  timelineRail: () => get<TimelineRail>('/api/timeline/rail'),
  /** Desktop chat companion column — tags/news/tape scoped to this chat's tickers. */
  chatRail: (chatId: string) =>
    get<TimelineRail & { chat_id: string }>(`/api/chats/${encodeURIComponent(chatId)}/rail`),
  publishTimeline: (share_id: string) =>
    post<{ ok: boolean; share_id: string; published_at: number }>('/api/timeline', { share_id }),
  unpublishTimeline: (shareId: string) =>
    // Owner of a human listing, or any admin (admins can also unlist bot shares).
    del<{ ok: boolean; share_id: string }>(`/api/timeline/${encodeURIComponent(shareId)}`),
  adminUsers: (limit?: number) =>
    get<{ items: AdminUser[] }>(`/api/admin/users${qs({ limit })}`),
  adminChatHistory: (opts?: { limit?: number; before?: string }) =>
    get<AdminChatHistoryResponse>(
      `/api/admin/chat_history${qs({ limit: opts?.limit, before: opts?.before })}`,
    ),
  adminBots: () => get<{ items: BotProfile[] }>('/api/admin/bots'),
  adminCopilotCapabilities: (opts?: { schema?: 'live' | 'placeholder'; samples?: boolean }) =>
    get<CopilotCapabilities>(
      `/api/admin/copilot/capabilities${qs({
        schema: opts?.schema,
        samples: opts?.samples ? '1' : undefined,
      })}`,
    ),
  adminBot: (handle: string) =>
    get<{ bot: BotProfile; runs: BotRun[]; schedule: BotSchedule | null }>(
      `/api/admin/bots/${encodeURIComponent(handle)}`,
    ),
  createBot: (body: Partial<BotProfile> & { handle: string; display_name: string; persona: string }) =>
    post<{ ok: true; bot: BotProfile }>('/api/admin/bots', body),
  updateBot: (handle: string, body: Partial<BotProfile>) =>
    request<{ ok: true; bot: BotProfile }>(`/api/admin/bots/${encodeURIComponent(handle)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteBot: (handle: string) =>
    request<{ ok: true }>(`/api/admin/bots/${encodeURIComponent(handle)}`, { method: 'DELETE' }),
  generateBotChat: (handle: string, prompt?: string) =>
    post<BotGenerateResponse>(`/api/admin/bots/${encodeURIComponent(handle)}/generate`, prompt ? { prompt } : {}),
  updateBotRun: (runId: string, body: { status: BotRun['status']; share_id?: string | null; error?: string | null }) =>
    request<{ ok: true; run: BotRun }>(`/api/admin/bots/runs/${encodeURIComponent(runId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  upsertBotSchedule: (
    handle: string,
    body: Partial<Pick<BotSchedule, 'enabled' | 'cadence_seconds' | 'market_gated' | 'prompt' | 'next_run_at'>>,
  ) =>
    request<{ ok: true; schedule: BotSchedule }>(
      `/api/admin/bots/${encodeURIComponent(handle)}/schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  deleteBotSchedule: (handle: string) =>
    request<{ ok: true }>(`/api/admin/bots/${encodeURIComponent(handle)}/schedule`, { method: 'DELETE' }),
  triggerBotSchedule: (handle: string, force = false) =>
    post<{
      ok: true;
      deferred?: boolean;
      reason?: string;
      next_run_at?: number;
      run_id?: string;
      chat_id?: string;
      share_id?: string;
      share_url?: string;
    }>(
      `/api/admin/bots/${encodeURIComponent(handle)}/schedule/trigger${force ? '?force=1' : ''}`,
      {},
    ),
  me: () => get<ProfileMe>('/api/me'),
  updateProfile: async (body: { handle?: string; display_name?: string | null }) => {
    const r = await fetch(`${API_BASE}/api/me`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({})) as { error?: string } & Partial<ProfileUpdate>;
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `API ${r.status}`);
    return data as ProfileUpdate;
  },
  /** @deprecated Use updateProfile({ handle }) */
  setHandle: async (handle: string) => {
    return api.updateProfile({ handle });
  },
  uploadAvatar: async (file: Blob, contentType?: string) => {
    const form = new FormData();
    const type = contentType || (file instanceof File ? file.type : 'image/jpeg') || 'image/jpeg';
    const name = file instanceof File
      ? file.name
      : `avatar.${type.includes('svg') ? 'svg' : type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'}`;
    form.append('avatar', file, name);
    const r = await fetch(`${API_BASE}/api/me/avatar`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const data = await r.json().catch(() => ({})) as { error?: string } & Partial<ProfileUpdate>;
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `API ${r.status}`);
    return data as ProfileUpdate;
  },
  clearAvatar: async () => {
    const r = await fetch(`${API_BASE}/api/me/avatar`, {
      method: 'DELETE',
      credentials: 'include',
    });
    const data = await r.json().catch(() => ({})) as { error?: string } & Partial<ProfileUpdate>;
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `API ${r.status}`);
    return data as ProfileUpdate;
  },
  /** Absolute URL for a relative `/api/avatars/...` path (or pass-through for absolute/blob URLs). */
  avatarSrc: (avatarUrl: string | null | undefined): string | null => {
    if (!avatarUrl) return null;
    if (/^(https?:|blob:|data:)/i.test(avatarUrl)) return avatarUrl;
    return `${API_BASE}${avatarUrl.startsWith('/') ? '' : '/'}${avatarUrl}`;
  },
  myChats: () => get<UserChatList>('/api/chats'),
  claimChat: (chat_id: string, title?: string) =>
    post<UserChatClaim>('/api/chats/claim', { chat_id, ...(title ? { title } : {}) }),
  renameChat: (chatId: string, title: string) =>
    patch<{ ok: boolean; title: string }>(`/api/chats/${encodeURIComponent(chatId)}`, { title }),
  deleteChat: (chatId: string) =>
    del<{ ok: boolean }>(`/api/chats/${encodeURIComponent(chatId)}`),
  research: (ticker: string, opts?: { force?: boolean; chatId?: string }) =>
    get<TickerResearch>(
      `/api/research/${encodeURIComponent(ticker.toUpperCase())}${qs({
        force: opts?.force ? 1 : undefined,
        chat_id: opts?.chatId,
      })}`,
    ),
  researchCommentary: (ticker: string, opts?: { force?: boolean }) =>
    get<TickerCommentary>(
      `/api/research/${encodeURIComponent(ticker.toUpperCase())}/commentary${qs({
        force: opts?.force ? 1 : undefined,
      })}`,
    ),
  researchChats: (ticker: string, limit?: number) =>
    get<ResearchChatsResponse>(
      `/api/research/${encodeURIComponent(ticker.toUpperCase())}/chats${qs({ limit })}`,
    ),
  researchFilings: (ticker: string, limit?: number) =>
    get<SecFilingsResponse>(
      `/api/research/${encodeURIComponent(ticker.toUpperCase())}/filings${qs({ limit })}`,
    ),
  chatTickers: (chatId: string) =>
    get<ChatTickerList>(`/api/chats/${encodeURIComponent(chatId)}/tickers`),
  chatTranscript: (chatId: string) =>
    get<ChatTranscriptBackup>(`/api/chats/${encodeURIComponent(chatId)}/transcript`),
};

import { useState, useEffect } from 'react';

/**
 * Readiness hook. With the Worker backend there is no in-browser dataset to
 * load, so this is always ready. Kept for backwards compatibility with the
 * DuckDB-WASM-era App.tsx loading gate.
 */
export function useDbReady(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({
    ready: true,
    error: null,
  });
  useEffect(() => {
    setState({ ready: true, error: null });
  }, []);
  return state;
}
