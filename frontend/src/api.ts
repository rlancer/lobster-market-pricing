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

export interface LiquidityCriteria {
  min_volume: number;
  min_open_interest: number;
  max_spread: number;
  atm_band: number;
  min_atm_contracts: number;
}

export interface LiquidityInfo {
  enabled_defaults: LiquidityCriteria;
  total_underlyings: number;
  liquid_underlyings: number;
  description: string;
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

/** One daily spot OHLC bar for an underlying (options.ohlc, newest run per date). */
export interface OhlcBar {
  date: string; // YYYY-MM-DD
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
  liquid: boolean;
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
}

export type ShareChatMessage = SharedChatMessage;

export interface ShareChatRecord extends Omit<ChatHistoryRecord, 'messages'> {
  messages: ShareChatMessage[];
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
  author?: { handle: string; name: string } | null;
}

export interface TimelineAuthor {
  handle: string;
  name: string;
}

export interface TimelinePost {
  share_id: string;
  url: string;
  title: string | null;
  excerpt: string;
  /**
   * First user→assistant turn (or a lone first message) for chat-style feed
   * rendering — includes sql / reasoning / chart when the share has them.
   */
  messages: SharedChatMessage[];
  handle: string;
  name: string;
  published_at: number;
  model: string | null;
  has_sql: boolean;
  has_chart: boolean;
}

export interface TimelineFeed {
  items: TimelinePost[];
  next_before: number | null;
  profile: TimelineAuthor | null;
}

export interface Health {
  ok: boolean;
  auth?: { google: boolean };
}

export interface ProfileMe {
  ok: true;
  id: string;
  name: string;
  email: string;
  image: string | null;
  handle: string | null;
  suggested_handle: string | null;
}

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
  earnings: Array<{
    earnings_date: string;
    time: string | null;
    fiscal_q: string | null;
    eps_forecast: number | null;
    last_year_eps: number | null;
    name: string | null;
  }>;
  news: Array<{ title: string; link: string }>;
  etf: {
    name: string | null;
    family: string | null;
    category: string | null;
    net_assets: number | null;
    expense_ratio: number | null;
  } | null;
  commentary?: string | null;
  commentary_source?: 'llm' | 'notes' | null;
  commentary_computed_at?: string | null;
  computed_at: string;
  expires_at: string;
  cache_hit: boolean;
}

export interface TickerCommentary {
  ticker: string;
  security_id: string;
  commentary: string;
  source: 'llm' | 'notes';
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
  stats: (liquid_only?: boolean) => get<Stats>(`/api/stats${qs({ liquid_only })}`),
  runs: (limit?: number) => get<RefreshRun[]>(`/api/runs${qs({ limit })}`),
  sectors: (liquid_only?: boolean) => get<SectorRow[]>(`/api/sectors${qs({ liquid_only })}`),
  symbols: (q: string, liquid_only?: boolean) =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ q: q || undefined, liquid_only })}`),
  // Full symbol universe (names/sectors) for the cross-session typeahead cache;
  // the server caps at 1000 and the lake holds ~500 underlyings.
  symbolsAll: (liquid_only?: boolean) =>
    get<SymbolSuggestion[]>(`/api/symbols${qs({ liquid_only, limit: 1000 })}`),
  liquidity: () => get<LiquidityInfo>('/api/liquidity'),
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
  symbolDetail: (symbol: string) => get<SymbolDetail>(`/api/symbol/${encodeURIComponent(symbol.toUpperCase())}`),
  notebookPremium: (params: {
    target_dte?: number;
    tolerance?: number;
    moneyness_band?: number;
    min_volume?: number;
    liquid_only?: boolean;
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
    get<TimelineFeed>(`/api/timeline${qs({ handle: opts?.handle, before: opts?.before, limit: opts?.limit })}`),
  publishTimeline: (share_id: string) =>
    post<{ ok: boolean; share_id: string; published_at: number }>('/api/timeline', { share_id }),
  unpublishTimeline: (shareId: string) =>
    del<{ ok: boolean; share_id: string }>(`/api/timeline/${encodeURIComponent(shareId)}`),
  me: () => get<ProfileMe>('/api/me'),
  setHandle: async (handle: string) => {
    const r = await fetch(`${API_BASE}/api/me`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    });
    const data = await r.json().catch(() => ({})) as { error?: string; handle?: string; ok?: boolean };
    if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `API ${r.status}`);
    return data as ProfileHandle;
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
