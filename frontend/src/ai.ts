// AI copilot for the options screener.
// Two modes:
//   - BYOK (default): the user's OpenRouter API key lives in localStorage and
//     goes straight from the browser to OpenRouter — no server in that path.
//   - Free (no key): chats are funded by the site's OpenRouter credit through
//     the Worker proxy (/api/free/v1, model pinned + allowlisted, max_tokens
//     clamped). The metered Tavily tools (get_news / web_search) are excluded;
//     402 free_credit_exhausted pivots the UI to the BYOK connect gate.
//
// Flow per question (TanStack AI agent loop):
//   1. Gather schema context (tables, columns, types, row counts, sample rows)
//      via the Worker.
//   2. Ask an agent (chat() + `run_query` + `check_schema` + `list_frames` +
//      `filter_frame` + `refresh_frame` tools) to answer the question. The model
//      writes DataFusion (R2 SQL); every proposed query is deterministically
//      validated against the real schema (unknown tables / columns rejected with
//      a precise message), executed against the CBOE Iceberg lake via the
//      Worker's /api/query, summarized, and any error is fixed by calling the
//      tool again — all inside the agent loop. Prior turns are threaded into the
//      agent as messages, and results the model materializes with `save_as`
//      become per-chat cached "frames" that follow-ups slice locally via
//      filter_frame — no lake re-pull.
//   3. Return { answer, sql, result } (last executed SQL/transform + result for the UI).

import { chat, toolDefinition, maxIterations } from '@tanstack/ai';
import { OpenAICompatibleChatAdapter } from '@tanstack/ai-openai/compatible';
import OpenAI from 'openai';
import { z } from 'zod';
import { api, API_BASE } from './api';
import type { QueryResult } from './api';
import type { ChartSpec } from './Chart';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'Open Interest Options Workspace';

// Free-tier chat model: the site's OpenRouter key funds anonymous chats
// through the Worker proxy (/api/free/v1). Pinned to the priced alias so the
// free tier follows OpenRouter price/availability drops; the Worker
// re-validates it server-side (allowlist) and clamps max_tokens.
export const FREE_MODEL = '~deepseek/deepseek-v4-flash-latest';

// ---------------------------------------------------------------------------
// Per-chat data cache ("frames")
// ---------------------------------------------------------------------------
// A frame is a named, immutable snapshot of a query result kept in the browser
// for the life of one chat. The model materializes frames with run_query
// `save_as` (which raises the row cap from 200 to FRAME_QUERY_LIMIT) and slices
// them with filter_frame / refresh_frame — follow-ups ("only ≤45 DTE", "20
// strikes around spot") become local filter/sort/slice ops instead of lake
// queries. Frames carry per-column sketches (min/max/distinct) so the model can
// reason about ranges without querying, and expire after FRAME_TTL_MS so the
// view never silently slices stale data (the lake refreshes nightly).
export const FRAME_TTL_MS = 15 * 60 * 1000;
const MAX_FRAMES = 8;
const MAX_FRAME_ROWS = 100_000;
/** Row cap for run_query calls that materialize a frame (worker clamps to 10k). */
export const FRAME_QUERY_LIMIT = 5000;
/** Text turns kept from chat history and threaded into the agent as messages. */
const HISTORY_TURNS = 16;

export interface FrameColumnSketch {
  type: 'number' | 'string' | 'boolean' | 'other';
  min?: number;
  max?: number;
  /** Up to MAX_SKETCH_DISTINCT distinct non-null string values (low-cardinality hints). */
  values?: string[];
}

export interface DataFrame {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  summary: Record<string, FrameColumnSketch>;
  /** Origin SQL — refresh_frame re-runs it against the lake. */
  sql: string;
  /** Epoch ms at materialization (stale after FRAME_TTL_MS). */
  fetched_at: number;
}

export type FrameStore = Map<string, DataFrame>;

export interface ChatSession {
  /** Prior turns (text only) in display order — threaded into the agent as messages. */
  history: { role: 'user' | 'assistant'; content: string }[];
  frames: FrameStore;
}

export function createSession(): ChatSession {
  return { history: [], frames: new Map() };
}

// ---------------------------------------------------------------------------
// Credential / model helpers (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'openinterest_ai_key';
const MODEL_KEY = 'openinterest_ai_model';
// Default to OpenRouter's auto-routing alias: it's always offered in the
// selector (live and fallback) and picks a working model regardless of account.
const DEFAULT_MODEL = 'openrouter/auto';

export function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}
export function setApiKey(k: string): void {
  localStorage.setItem(STORAGE_KEY, k.trim());
}
export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
export function getModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? DEFAULT_MODEL;
}
export function setModel(m: string): void {
  localStorage.setItem(MODEL_KEY, m.trim());
}

// ---------------------------------------------------------------------------
// Reasoning-effort preference (localStorage)
// ---------------------------------------------------------------------------
// OpenAI-style reasoning models (e.g. openai/gpt-5.6-luna) accept an optional
// `reasoning_effort` of low/medium/high via OpenRouter. Not every model accepts
// it, so senders must check `modelSupports(model, 'reasoning_effort')` first.
export type ReasoningEffort = 'low' | 'medium' | 'high';
const EFFORT_KEY = 'openinterest_ai_effort';
const DEFAULT_EFFORT: ReasoningEffort = 'medium';
const EFFORT_VALUES = ['low', 'medium', 'high'] as const;

export function getEffort(): ReasoningEffort {
  const v = localStorage.getItem(EFFORT_KEY);
  return (EFFORT_VALUES as readonly string[]).includes(v ?? '') ? (v as ReasoningEffort) : DEFAULT_EFFORT;
}
export function setEffort(e: ReasoningEffort): void {
  localStorage.setItem(EFFORT_KEY, e);
}

// ---------------------------------------------------------------------------
// Model catalog (OpenRouter /models, filtered for the pilot agent)
// ---------------------------------------------------------------------------
// The Copilot runs a TanStack AI agent that needs function/tool calling, and we
// only want live, current models. OpenRouter's public /models endpoint (no key
// required) exposes `supported_parameters` (does it accept tools?) and `created`
// (epoch seconds) per model, so we surface tool-capable models released within
// the last ~6 months and group them by provider.
export interface ModelChoice {
  value: string;
  label: string;
}
export interface ModelGroup {
  title: string;
  options: ModelChoice[];
}

interface CatalogModel {
  id: string;
  name?: string;
  created?: number;
  supported_parameters?: string[];
  architecture?: {
    output_modalities?: string[];
  };
}

// Curated fallback (used if the live fetch fails / app is offline). Also
// guarantees `openrouter/auto` is always offered — it's a routing alias, not an
// entry in the /models catalog.
export const FALLBACK_MODEL_GROUPS: ModelGroup[] = [
  {
    title: 'Anthropic',
    options: [
      { value: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
      { value: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku' },
    ],
  },
  {
    title: 'OpenAI',
    options: [
      { value: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
      { value: 'openai/gpt-4o', label: 'GPT-4o' },
    ],
  },
  {
    title: 'Google',
    options: [{ value: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' }],
  },
  {
    title: 'Meta',
    options: [{ value: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' }],
  },
  {
    title: 'Auto',
    options: [{ value: 'openrouter/auto', label: 'OpenRouter auto' }],
  },
];

const MODELS_RECENCY_MS = 1000 * 60 * 60 * 24 * 30 * 6; // ~6 months
const toolCapable = (m: CatalogModel): boolean =>
  Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');
const isRecent = (m: CatalogModel): boolean =>
  typeof m.created === 'number' && Date.now() - m.created * 1000 < MODELS_RECENCY_MS;
// Exclude image-generation models (e.g. dalle/flux/gemini-*-image): they don't
// belong in a chat model picker. Only OUTPUT modality matters — vision input on
// a text-output chat model is fine.
const hasImageOutput = (m: CatalogModel): boolean =>
  Array.isArray(m.architecture?.output_modalities) &&
  m.architecture.output_modalities.includes('image');

// Model id → supported_parameters, filled from the live /models catalog so callers
// only send provider-specific options to models that accept them. Empty/unknown
// models conservatively report "not supported".
const modelSupportedParams = new Map<string, string[]>();

/** True when the catalog says `model` accepts the given parameter (e.g. 'reasoning_effort'). */
export function modelSupports(model: string, param: string): boolean {
  return modelSupportedParams.get(model)?.includes(param) ?? false;
}

/** True once the catalog has authoritative params for `model` (false while loading / unknown / fetch failed). */
export function modelHasParams(model: string): boolean {
  return modelSupportedParams.has(model);
}

async function fetchOpenRouterModels(): Promise<ModelGroup[]> {
  const res = await fetch(`${OPENROUTER_BASE}/models`);
  if (!res.ok) throw new Error(`Failed to load OpenRouter models (${res.status})`);
  const json = (await res.json()) as { data?: CatalogModel[] };

  const qualified = (json.data ?? []).filter(
    (m): m is CatalogModel =>
      !!m &&
      typeof m.id === 'string' &&
      // The `:free` tier is unreliable ($0 OpenRouter accounts can't keep a
      // session alive), so drop those models from the picker entirely.
      !m.id.endsWith(':free') &&
      toolCapable(m) &&
      isRecent(m) &&
      !hasImageOutput(m),
  );
  // Record per-model supported_parameters so senders know which provider-specific
  // options (e.g. reasoning_effort) each model actually accepts.
  for (const m of qualified) modelSupportedParams.set(m.id, m.supported_parameters ?? []);

  const choices = qualified
    // Strip the redundant "{Provider}: " prefix from OpenRouter's display name
    // since options are already grouped into provider sections.
    .map((m): ModelChoice => ({
      value: m.id,
      label: (m.name && m.name.replace(/^[^:]+:\s*/, '')) || m.id,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));

  const byProvider = new Map<string, ModelChoice[]>();
  for (const c of choices) {
    const slash = c.value.indexOf('/');
    const provider = slash > 0 ? c.value.slice(0, slash) : 'other';
    const list = byProvider.get(provider);
    if (list) list.push(c);
    else byProvider.set(provider, [c]);
  }

  const groups: ModelGroup[] = [];
  groups.push({ title: 'Auto', options: [{ value: 'openrouter/auto', label: 'OpenRouter auto' }] });
  for (const [provider, options] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({ title: provider, options });
  }
  return groups;
}

/** Best-effort live load; rejects so callers can fall back to FALLBACK_MODEL_GROUPS. */
export async function fetchAvailableModels(): Promise<ModelGroup[]> {
  return fetchOpenRouterModels();
}

// ---------------------------------------------------------------------------
// OpenRouter OAuth (PKCE) "connect" flow
// ---------------------------------------------------------------------------
// Instead of asking users to hand-paste an API key, they can click a
// "Connect with OpenRouter" button. We bounce them to openrouter.ai/auth;
// after they log in + authorize, OpenRouter redirects back with a short-lived
// `code`. We exchange that code for a user-controlled API key and store it in
// localStorage (same place as a manually-entered key) — it never touches our
// server. The user can revoke the key from their OpenRouter dashboard.
//
// Docs: https://openrouter.ai/docs/guides/overview/auth/oauth.md

const OAUTH_SESSION_KEY = 'openinterest_oauth_verifier';
const OAUTH_CALLBACK_PARAM = 'oauth_callback';

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a cryptographically-random URL-safe string (127 chars). */
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** SHA-256 hash of the verifier -> base64url challenge (for S256). */
async function sha256CodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64Url(new Uint8Array(hash));
}

/**
 * Kick off the OpenRouter PKCE flow: save the verifier, then redirect to
 * OpenRouter's auth page. The callback URL is this same origin with a
 * `?oauth_callback=1` marker so the app can detect the return trip.
 */
export async function startOAuthFlow(): Promise<void> {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(OAUTH_SESSION_KEY, verifier);
  const challenge = await sha256CodeChallenge(verifier);
  // Land the redirect back on the Copilot route (/ai), not the site root, so
  // the path itself restores the tab after the full-page OAuth round trip.
  const callbackUrl = `${window.location.origin}/ai?${OAUTH_CALLBACK_PARAM}=1`;
  const authUrl =
    'https://openrouter.ai/auth?' +
    `callback_url=${encodeURIComponent(callbackUrl)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    '&code_challenge_method=S256';
  window.location.href = authUrl;
}

/** Detect whether the current URL is an OpenRouter OAuth callback. */
export function isOAuthCallback(): boolean {
  const p = new URLSearchParams(window.location.search);
  // OpenRouter appends `?code=...` to the redirect URL but drops the
  // `oauth_callback=1` marker we put in the callback_url (observed live:
  // it returned `/ai?code=…` with no marker). So detect the return trip by
  // the `code` param; keep the marker check only as defense in depth.
  return p.has('code') || p.get(OAUTH_CALLBACK_PARAM) === '1';
}

/**
 * If the current URL is an OAuth callback, exchange the `code` for an API key,
 * store it, strip the callback params from the URL, and return true.
 * Returns false if there is no callback to handle.
 */
export async function handleOAuthCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  // OpenRouter drops the `oauth_callback=1` marker (only `?code=…` survives),
  // so the presence of `code` alone identifies the return trip.
  if (!code && params.get(OAUTH_CALLBACK_PARAM) !== '1') return false;

  const verifier = sessionStorage.getItem(OAUTH_SESSION_KEY);
  sessionStorage.removeItem(OAUTH_SESSION_KEY);

  // Always clean the callback params from the URL once we've seen them.
  params.delete(OAUTH_CALLBACK_PARAM);
  params.delete('code');
  const qs = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${qs ? `?${qs}` : ''}`,
  );

  console.log('[OpenRouter OAuth] callback code:', code);

  if (!code) throw new Error('OAuth callback missing the authorization code.');

  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = j?.error?.message ?? j?.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`OpenRouter connect failed (${res.status}): ${detail}`);
  }

  const j = await res.json();
  const key = j?.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('OpenRouter did not return an API key.');
  }
  setApiKey(key);
  console.log(
    `[OpenRouter OAuth] API key stored in localStorage (len=${key.length}); ` +
      `chat is configured.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Schema context builder
// ---------------------------------------------------------------------------
export interface SchemaTable {
  name: string;
  row_count: number | null;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}
export interface SchemaContext {
  tables: SchemaTable[];
}

export async function buildSchemaContext(): Promise<SchemaContext> {
  // Single round trip: /api/tables now carries columns, row counts AND sample
  // rows (cached in the Worker's D1), so no per-table SELECT * is needed here.
  const tables = await api.tables();
  return {
    tables: tables.map((t) => ({
      name: t.name,
      row_count: t.row_count,
      columns: t.columns,
      sample: t.sample ?? [],
    })),
  };
}

function schemaToPrompt(ctx: SchemaContext): string {
  return ctx.tables
    .map((t) => {
      const size =
        t.row_count == null
          ? ''
          : `  row_count: ${t.row_count.toLocaleString('en-US')}\n`;
      const cols = t.columns.map((c) => `    ${c.name} ${c.type}`).join('\n');
      const sample = t.sample.length
        ? '  sample rows:\n' +
          t.sample.map((r) => '    ' + JSON.stringify(r)).join('\n')
        : '';
      // Harvest distinct low-cardinality values (e.g. type in {call,put}) straight
      // from the sample rows so the model knows legal enum members without a query.
      const distinct: string[] = [];
      for (const c of t.columns) {
        const vals = Array.from(
          new Set(t.sample.map((r) => r[c.name]).filter((v) => v != null)),
        );
        if (vals.length > 0 && vals.length <= 6) {
          distinct.push(`    ${c.name} in {${vals.map((v) => JSON.stringify(v)).join(', ')}}`);
        }
      }
      const distinctStr = distinct.length ? '\n  low-cardinality values:\n' + distinct.join('\n') : '';
      return `TABLE options.${t.name}\n  columns:\n${cols}${sample}${distinctStr}${size}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Deterministic schema validator
// ---------------------------------------------------------------------------
// Grounds model-written SQL against the *real* schema regardless of whether the
// model read the system prompt. Catches hallucinated tables/columns before the
// query runs and returns a precise, actionable error so the agent loop can fix
// it (autocorrect). Deliberately conservative: we only flag identifiers we can
// resolve with high confidence, never bare/ambiguous names — a false positive
// here would block otherwise-valid SQL, so we'd rather skip than misjudge.
interface ValidatedIssue {
  severity: 'error' | 'warning';
  message: string;
}

const SQL_ALIAS_KEYWORDS = new Set([
  'on', 'as', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'join',
  'where', 'using', 'select', 'from', 'group', 'by', 'having', 'order',
  'limit', 'qualify', 'with', 'and', 'or', 'not', 'case', 'when', 'then',
  'else', 'end', 'union', 'all', 'intersect', 'except', 'exists', 'in',
  'is', 'null', 'distinct', 'over', 'partition', 'rows', 'between', 'like',
]);

function validateSqlSchema(sql: string, ctx: SchemaContext): ValidatedIssue[] {
  const tables = ctx.tables.map((t) => t.name);
  const lowerTables = new Set(tables.map((t) => t.toLowerCase()));
  const columnsByTable = new Map<string, Set<string>>();
  for (const t of ctx.tables) {
    columnsByTable.set(t.name.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase())));
  }

  // Strip string literals ('...', '' escapes) so values can't be mistaken for
  // identifiers.
  let s = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (sql[i + 1] === "'") { i++; s += ' '; continue; }
      // toggle: inside a string literal we replace everything up to the close quote
      s += ' ';
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    s += ch;
  }

  // CTE names ('WITH name AS (') are not physical tables; collect them so we
  // don't flag them as unknown when referenced.
  const cteNames = new Set<string>();
  const cteRe = /([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cteRe.exec(s))) cteNames.add(cm[1].toLowerCase());

  const issues: ValidatedIssue[] = [];
  const tableIssued = new Set<string>();

  // ---- table references (FROM / JOIN) ----
  const aliasToTable = new Map<string, string>();
  const refRe = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(s))) {
    const ref = m[1];
    const alias = m[2] && !SQL_ALIAS_KEYWORDS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : null;
    const dot = ref.indexOf('.');
    const bare = dot === -1 ? ref : ref.slice(dot + 1);
    const ns = dot === -1 ? null : ref.slice(0, dot);
    const lb = bare.toLowerCase();

    if (cteNames.has(lb)) continue; // CTE, not a physical table
    if (lowerTables.has(lb)) {
      if (alias) aliasToTable.set(alias, lb);
      if (ns && ns.toLowerCase() !== 'options' && !tableIssued.has(lb)) {
        tableIssued.add(lb);
        issues.push({
          severity: 'error',
          message: `Unknown schema '${ns}'. Tables live in the 'options' schema (e.g. options.${bare}).`,
        });
      }
      continue;
    }
    if (tableIssued.has(lb)) continue;
    tableIssued.add(lb);
    if (ns) {
      issues.push({
        severity: 'error',
        message: `Unknown table '${ref}'. Available tables: ${tables.map((t) => `options.${t}`).join(', ')}. Fix the table name and try again.`,
      });
    } else {
      issues.push({
        severity: 'warning',
        message: `'${ref}' is not a known table and not a CTE. If it is a table, qualify it as options.${ref} (available tables: ${tables.map((t) => `options.${t}`).join(', ')}).`,
      });
    }
  }

  // ---- qualified column references (alias.col / table.col) ----
  // Only validate when we can resolve the qualifier; skip bare columns and
  // unresolvable aliases (subquery/CTE outputs) to avoid false positives.
  const colRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let cm2: RegExpExecArray | null;
  while ((cm2 = colRe.exec(s))) {
    const qual = cm2[1].toLowerCase();
    const col = cm2[2].toLowerCase();
    const tableName = aliasToTable.get(qual) ?? (lowerTables.has(qual) ? qual : null);
    if (!tableName) continue;
    const cols = columnsByTable.get(tableName);
    if (cols && !cols.has(col)) {
      issues.push({
        severity: 'warning',
        message: `Unknown column '${cm2[1]}.${cm2[2]}': table options.${tableName} has no column named '${cm2[2]}'. Columns: ${Array.from(cols).sort().join(', ')}.`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Frame helpers: column sketches, eviction, catalog text
// ---------------------------------------------------------------------------
const MAX_SKETCH_DISTINCT = 12;
// Sketch cost is bounded by sampling: a 100k-row frame never scans everything.
const MAX_SKETCH_ROWS = 20_000;

function sketchColumn(values: unknown[]): FrameColumnSketch {
  let type: FrameColumnSketch['type'] = 'other';
  let min: number | undefined;
  let max: number | undefined;
  const strings = new Set<string>();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (type === 'other') type = 'number';
      if (min === undefined || v < min) min = v;
      if (max === undefined || v > max) max = v;
    } else if (type === 'number' && typeof v === 'string' && !Number.isNaN(Number(v))) {
      const n = Number(v);
      if (min === undefined || n < min) min = n;
      if (max === undefined || n > max) max = n;
    } else if (typeof v === 'boolean') {
      if (type === 'other') type = 'boolean';
    } else {
      if (type === 'other') type = 'string';
      if (strings.size < MAX_SKETCH_DISTINCT) strings.add(String(v));
    }
  }
  const sketch: FrameColumnSketch = { type };
  if (min !== undefined) sketch.min = min;
  if (max !== undefined) sketch.max = max;
  if (strings.size > 0) sketch.values = [...strings].sort();
  return sketch;
}

function buildFrameSummary(
  columns: string[],
  rows: Record<string, unknown>[],
): Record<string, FrameColumnSketch> {
  const sampled = rows.slice(0, MAX_SKETCH_ROWS);
  const summary: Record<string, FrameColumnSketch> = {};
  for (const c of columns) summary[c] = sketchColumn(sampled.map((r) => r[c]));
  return summary;
}

/** Insert a frame, evicting oldest when over MAX_FRAMES. Empty frames are rejected. */
function saveFrame(store: FrameStore, frame: DataFrame): void {
  if (frame.row_count <= 0) return;
  if (frame.rows.length > MAX_FRAME_ROWS) {
    frame.rows = frame.rows.slice(0, MAX_FRAME_ROWS);
    frame.row_count = frame.rows.length;
  }
  store.set(frame.name, frame);
  while (store.size > MAX_FRAMES) {
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [name, f] of store) {
      if (f.fetched_at < oldestTs) { oldestTs = f.fetched_at; oldest = name; }
    }
    if (oldest) store.delete(oldest);
  }
}

function frameAgeText(frame: DataFrame): string {
  const min = Math.round((Date.now() - frame.fetched_at) / 60000);
  return min < 1 ? '<1 min' : `${min} min`;
}

function sketchText(sketch: FrameColumnSketch): string {
  if (sketch.type === 'number') {
    const range =
      sketch.min !== undefined && sketch.max !== undefined
        ? `${fmtNum(sketch.min)}..${fmtNum(sketch.max)}`
        : '?';
    return `number ${range}`;
  }
  if (sketch.type === 'string') {
    const vals = sketch.values?.length ? ` {${sketch.values.join(', ')}}` : '';
    return `string${vals}`;
  }
  return sketch.type;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

/** Compact catalog text for list_frames — what the model can slice without querying. */
function frameCatalogText(store: FrameStore): string {
  if (store.size === 0) {
    return (
      'No cached frames in this chat yet. When the question targets a specific ' +
      "symbol's data (chain, vol surface/smile, OI/IV profile), run_query with " +
      "save_as: '<name>' and SELECT a dte column (CAST(expiration AS DATE) - " +
      "CURRENT_DATE AS dte) — the result is cached and follow-ups can slice it " +
      'locally with filter_frame instead of re-querying the lake.'
    );
  }
  const lines: string[] = [];
  for (const f of store.values()) {
    const cols = f.columns
      .map((c) => `${c}: ${sketchText(f.summary[c])}`)
      .join(', ');
    lines.push(
      `- '${f.name}': ${f.row_count} rows × ${f.columns.length} cols, age ${frameAgeText(f)} — ${cols}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Local row slicing over cached frames (filter_frame engine)
// ---------------------------------------------------------------------------
// Where/sort are JS-style expressions over column names, e.g.
//   where: "dte <= 45 && type == 'call'"
//   sort:  "abs(strike - spot_price)"
// Supported: numbers, 'single-quoted strings', == != < <= > >=, && || !,
// parens, abs(x), min(a,b), max(a,b), round(x). Null safety: a null value in a
// compared column makes comparisons false (SQL-like); null checks are written
// `col == null` / `col != null`.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPR_KEYWORDS: Record<string, true> = {
  abs: true, min: true, max: true, round: true,
  true: true, false: true, null: true, undefined: true,
};

/**
 * Rewrite bare column identifiers to `(c === null ? undefined : c)` outside
 * string literals. Identifiers that are neither columns nor expression
 * keywords are collected into `outUnknowns` (if given) so compileExpr can fail
 * with a precise "unknown column" message instead of a runtime ReferenceError
 * that silently drops every row.
 */
function nullGuardExpr(
  expr: string,
  columns: Set<string>,
  outUnknowns?: string[],
): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'") {
      let j = i + 1;
      let lit = "'";
      while (j < expr.length) {
        lit += expr[j];
        if (expr[j] === "'") {
          if (expr[j + 1] === "'") { lit += "'"; j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += lit;
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      const word = expr.slice(i, j);
      if (columns.has(word) && !EXPR_KEYWORDS[word]) {
        out += `(${word} === null ? undefined : ${word})`;
      } else {
        out += word;
        if (!EXPR_KEYWORDS[word] && !columns.has(word)) outUnknowns?.push(word);
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Compile a where predicate or sort-key expression over the frame's columns. */
function compileExpr(
  columns: string[],
  expr: string,
  what: string,
): (row: Record<string, unknown>) => unknown {
  for (const c of columns) {
    if (!IDENT_RE.test(c)) {
      throw new Error(`column '${c}' can't be referenced in a ${what} expression`);
    }
  }
  const unknowns: string[] = [];
  const guarded = nullGuardExpr(expr, new Set(columns), unknowns);
  if (unknowns.length) {
    throw new Error(
      `${what} expression references unknown column(s): ${unknowns.join(', ')}. ` +
        `Frame columns: ${columns.length ? columns.join(', ') : '(none)'}. ` +
        'Re-run the source query to include them in the frame.',
    );
  }
  let fn: (...args: unknown[]) => unknown;
  try {
    fn = new Function(
      ...columns,
      'abs',
      'min',
      'max',
      'round',
      `"use strict"; return (${guarded});`,
    ) as (...args: unknown[]) => unknown;
  } catch {
    throw new Error(`${what} expression is not valid JavaScript: ${expr}`);
  }
  return (row) =>
    fn(
      ...columns.map((c) => row[c] ?? null),
      Math.abs,
      Math.min,
      Math.max,
      Math.round,
    );
}

function compareKeys(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export interface FrameSlice {
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
}

export function sliceFrame(
  frame: DataFrame,
  opts: {
    where?: string;
    sort?: string;
    limit?: number;
    project?: string[];
  } = {},
): FrameSlice {
  let columns = frame.columns;
  let rows = frame.rows;
  const where = opts.where?.trim();
  if (where) {
    const pred = compileExpr(columns, where, 'where');
    rows = rows.filter((r) => {
      try {
        return pred(r) === true;
      } catch {
        return false;
      }
    });
  }
  const sort = opts.sort?.trim();
  if (sort && rows.length > 1) {
    const keyFn = compileExpr(columns, sort, 'sort');
    const indexed = rows.map((r, i) => ({ r, i, k: keyFn(r) }));
    indexed.sort((a, b) => compareKeys(a.k, b.k) || a.i - b.i);
    rows = indexed.map((x) => x.r);
  }
  const limit = opts.limit;
  if (limit !== undefined && limit >= 0) rows = rows.slice(0, limit);
  if (opts.project && opts.project.length) {
    const keep = new Set(opts.project.filter((c) => columns.includes(c)));
    if (keep.size > 0) {
      columns = columns.filter((c) => keep.has(c));
      rows = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of columns) o[c] = r[c];
        return o;
      });
    }
  }
  return { columns, rows, row_count: rows.length };
}

// ---------------------------------------------------------------------------
// Result summariser (compact text fed back to the model inside the tool)
// ---------------------------------------------------------------------------
function summarizeResult(res: QueryResult): string {
  const { columns, rows, row_count } = res;
  const lines: string[] = [`Columns: ${columns.join(', ')}`, `Row count: ${row_count}`];
  const shown = rows.slice(0, 30);
  if (shown.length > 0) {
    lines.push('---', 'Rows (pipe-separated):');
    for (const r of shown) {
      const vals = columns.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number') {
          return Number.isInteger(v) ? String(v) : v.toFixed(4);
        }
        if (typeof v === 'boolean') return String(v);
        const s = String(v);
        return s.length > 120 ? s.slice(0, 117) + '…' : s;
      });
      lines.push('  ' + vals.join(' | '));
    }
    if (rows.length > 30) lines.push(`  … (showing 30 of ${row_count} rows)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Agent tool: run a read-only query via the Worker
// ---------------------------------------------------------------------------
// The `run_query` tool is what turns the generic chat() loop into an agent:
// the model proposes SQL, the tool executes it and returns a compact summary
// the model can reason over, and the loop repeats (fix on error) until the
// model answers. The full QueryResult is captured for the UI separately from
// what the model sees.
const runQueryDef = toolDefinition({
  name: 'run_query',
  description:
    'Execute ONE read-only DataFusion (R2 SQL) SELECT/WITH query against the ' +
    'CBOE options Iceberg lake and return a compact result summary. Tables live ' +
    'in the `options` schema. Use this to answer questions about the data. ' +
    'SQL is validated against the real schema before running. ' +
    'With `save_as`, the full result (up to 5000 rows) is cached as a named ' +
    'per-chat frame that filter_frame can slice locally — use it when you fetch ' +
    'chartable data for a specific symbol (chain, surface, smile, OI profile) so ' +
    'follow-up filters never re-query the lake.',
  inputSchema: z.object({
    sql: z.string().describe('A single read-only SQL query (SELECT or WITH).'),
    save_as: z.string().optional().describe(
      'Optional frame name (e.g. "aapl_surface") to cache this result as a per-chat ' +
      'frame. When set, up to 5000 rows are returned/cached (200 otherwise). For ' +
      'surface/chain/smile data, SELECT a dte column (CAST(expiration AS DATE) - ' +
      'CURRENT_DATE AS dte) and spot_price so follow-ups can filter locally.',
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the query ran without an error.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
    summary: z.string().describe('Compact result summary for reasoning.'),
  }),
});

const checkSchemaDef = toolDefinition({
  name: 'check_schema',
  description:
    'Deterministically validate a proposed SQL query against the real table and ' +
    'column names in the `options` schema — without executing it. Returns any ' +
    'unknown tables/columns so you can fix them before calling run_query.',
  inputSchema: z.object({
    sql: z.string().describe('The SQL query to validate against the schema.'),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the query references only known tables/columns.'),
    issues: z.array(z.string()).describe('Human-readable validation issues, if any.'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tools: per-chat cached frames (list / filter / refresh)
// ---------------------------------------------------------------------------
// Frames let follow-up questions slice already-fetched data locally instead of
// re-pulling the lake. The model materializes a frame with run_query save_as,
// checks what it holds with list_frames, slices it with filter_frame, and can
// re-pull a stale one with refresh_frame.

const listFramesDef = toolDefinition({
  name: 'list_frames',
  description:
    'List per-chat cached data frames (results materialized with run_query ' +
    'save_as). Includes columns, row counts, age in minutes, and per-column ' +
    'min/max/distinct hints — enough to decide whether you can answer with ' +
    'filter_frame on cached data instead of querying the lake again. Frames ' +
    'expire after 15 minutes.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether listing succeeded.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
    summary: z.string().describe('Frame catalog.'),
  }),
});

const filterFrameDef = toolDefinition({
  name: 'filter_frame',
  description:
    'Filter/sort/project a named cached frame entirely in the browser — NO lake ' +
    'query. The result becomes the active data result for render_chart and the ' +
    'chat table. `where` is a JS-style predicate over column names (examples: ' +
    '"dte <= 45", "abs(strike - spot_price) / spot_price <= 0.05 && dte <= 60", ' +
    '"type == \'call\' && open_interest > 1000"). `sort` is an expression for the ' +
    'sort key, ascending (e.g. "abs(strike - spot_price)" for proximity to spot, ' +
    '"dte" for nearest expiry); combine with `limit` for a top-N slice. Supported: ' +
    'numbers, \'single-quoted strings\', == != < <= > >=, && || !, parens, ' +
    'abs(x), min(a,b), max(a,b), round(x). Null semantics: rows with a null value ' +
    'in a compared column are excluded (SQL-like); null checks are written ' +
    '"col == null" / "col != null". Prefer this over re-querying the lake when ' +
    'the frame already has the columns you need.',
  inputSchema: z.object({
    frame: z.string().describe('Name of the cached frame to slice (see list_frames).'),
    where: z.string().optional().describe('Optional JS-style predicate; rows where it is false are dropped.'),
    sort: z.string().optional().describe('Optional expression producing the ascending sort key.'),
    limit: z.number().int().nonnegative().optional().describe('Optional max rows to return (after sort).'),
    project: z.array(z.string()).optional().describe('Optional columns to keep (default all).'),
    save_as: z.string().optional().describe(
      'Optional frame name to cache the slice for later steps (e.g. "aapl_45dte").',
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the slice succeeded.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
    summary: z.string().describe('Compact result summary for reasoning.'),
  }),
});

const refreshFrameDef = toolDefinition({
  name: 'refresh_frame',
  description:
    'Re-pull a cached frame\'s source query from the lake and replace its rows. ' +
    'Use when list_frames or a filter_frame error reports the frame is stale ' +
    '(frames expire after 15 minutes; the lake refreshes nightly).',
  inputSchema: z.object({
    frame: z.string().describe('Name of the cached frame to refresh.'),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the refresh succeeded.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
    summary: z.string().describe('Compact result summary for reasoning.'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tool: render a chart of the most recent query result in the chat UI
// ---------------------------------------------------------------------------
// The model fetches chartable data with run_query, then calls render_chart to
// request a chart. The frontend captures the spec (from the tool-call input)
// alongside the last query result and renders it — the tool itself is a no-op
// server-side; its only job is to appear in the agent loop so the model can
// declare a chart and keep producing the natural-language answer.
const renderChartDef = toolDefinition({
  name: 'render_chart',
  description:
    'Show the most recent run_query result as a chart in the chat. Call this AFTER a ' +
    'run_query that fetched the chart data, naming the EXACT result columns to plot: ' +
    '`x` (x-axis), `y` (y-axis), and optionally `series` to split into one line/bar per ' +
    'distinct value. For a volatility surface: x=strike, y=implied_vol, series=expiration ' +
    '(or a DTE column) → one curve per expiration. For a stock OI/IV profile: x=strike, ' +
    'y=(open_interest|implied_vol), series=type. Use `line` for curves/surfaces, `bar` for ' +
    'single-variable magnitude (e.g. OI by strike), `scatter` for point clouds.',
  inputSchema: z.object({
    title: z.string().optional().describe('Short chart heading.'),
    kind: z.enum(['line', 'area', 'scatter', 'bar']).default('line'),
    x: z.string().describe('Column in the most recent query result for the x-axis.'),
    y: z.string().describe('Column in the most recent query result for the y-axis.'),
    series: z.string().optional().describe('Optional column that splits data into one series per value.'),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean().describe('Whether the chart spec is well-formed.'),
    error: z.string().nullable().describe('Error message, or null when ok.'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tool: fetch recent news headlines for a symbol (Worker → Tavily)
// ---------------------------------------------------------------------------
// Narrative half of "why is this moving": the lake has no news, so the model
// pulls headlines when a vol/OI/price question needs context. Hits the
// /api/news endpoint (Tavily news search, proxied + cached by the Worker);
// upstream failures degrade to an error string, never a thrown tool, so a news
// outage cannot block the answer. Headlines carry source links the model can
// cite.
const newsDef = toolDefinition({
  name: 'get_news',
  description:
    'Fetch recent news headlines for ONE symbol (e.g. "AAPL"). Use this when ' +
    'the user asks WHY a stock, its option volume, or its implied volatility ' +
    'is high or unusual — the lake has no news. Pair it with an IV vs ' +
    'realized-vol query and an options.earnings check for event risk.',
  inputSchema: z.object({
    symbol: z.string().describe('Ticker symbol, e.g. "AAPL".'),
    limit: z.number().int().min(1).max(20).optional().describe('Max headlines (default 8).'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    summary: z.string().describe('Numbered headline list (title + source link) for reasoning.'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tool: upcoming macro / FOMC calendar (binary-event weeks)
// ---------------------------------------------------------------------------
// Macro events (FOMC, CPI, jobs, PCE) lift broad implied vol — "why is
// everything rich" almost always has a calendar component. Hits
// /api/econ_calendar (FRED releases/dates, keyless Fed-calendar fallback,
// cached by the Worker); degrades to an error string, never a thrown tool.
const ecoCalendarDef = toolDefinition({
  name: 'eco_calendar',
  description:
    'Fetch scheduled macro events for the next ~30 days (FOMC meetings, ' +
    'statements, minutes, Beige Book, CPI, jobs, PCE...). Use when the user ' +
    'asks about binary-event weeks, macro drivers of broad vol, or what is ' +
    'coming up for the market at large.',
  inputSchema: z.object({
    days: z.number().int().min(7).max(90).optional().describe('Window in days (default 30).'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    summary: z.string().describe('Numbered list of upcoming events (date + name).'),
  }),
});

// ---------------------------------------------------------------------------
// Agent tool: general web search (Worker → Tavily)
// ---------------------------------------------------------------------------
// Fresh analyst/market commentary beyond the per-ticker news feed: sector
// themes, macro reactions, "what happened / what is the latest take on X".
// Hits /api/web_search (Tavily general search, proxied + cached by the
// Worker); degrades to an error string, never a thrown tool. Results carry
// source links the model can cite.
const webSearchDef = toolDefinition({
  name: 'web_search',
  description:
    'Search the web for fresh analyst/market commentary or current events ' +
    '(capped at 5 results). Use when the user asks about recent market moves, ' +
    'analyst opinions, sector themes, earnings reactions, or anything newer ' +
    'than the per-ticker get_news feed. Cite the links you use in your answer.',
  inputSchema: z.object({
    query: z.string().describe('Search query, e.g. "NVDA analyst commentary this week".'),
    max_results: z.number().int().min(1).max(5).optional().describe('Max results (default 5).'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    summary: z.string().describe('Numbered result list (title + source link) for reasoning.'),
  }),
});

// ---------------------------------------------------------------------------
// TanStack AI agent: answer a question by writing + running SQL
// ---------------------------------------------------------------------------
// OpenAI-compatible adapter subclass that surfaces provider reasoning deltas.
// OpenRouter's DeepSeek stream (and several other reasoning providers) ships
// thinking tokens in `delta.reasoning` / `delta.reasoning_details` (older
// variants use `delta.reasoning_content`), but the stock compatible adapter's
// `extractReasoning` hook is a no-op — those tokens would silently die at the
// adapter boundary. Overriding the hook feeds them into the standard
// REASONING_MESSAGE_CONTENT stream so live reasoning reaches the chat UI.
class ReasoningCompatibleTextAdapter extends OpenAICompatibleChatAdapter<string, Record<string, unknown>> {
  protected override extractReasoning(chunk: unknown): { text: string } | undefined {
    if (!chunk || typeof chunk !== 'object') return undefined;
    if (!('choices' in chunk) || !Array.isArray(chunk.choices) || chunk.choices.length === 0) return undefined;
    const choice = chunk.choices[0];
    if (!choice || typeof choice !== 'object' || !('delta' in choice)) return undefined;
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') return undefined;
    if ('reasoning' in delta && typeof delta.reasoning === 'string') return { text: delta.reasoning };
    if ('reasoning_content' in delta && typeof delta.reasoning_content === 'string') {
      return { text: delta.reasoning_content };
    }
    if ('reasoning_details' in delta && Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
      const item = delta.reasoning_details[delta.reasoning_details.length - 1];
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        return { text: item.text };
      }
    }
    return undefined;
  }
}

interface AgentCapture {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
}

function systemPrompt(schemaPrompt: string, freeMode = false): string {
  return [
    'You are a senior quant developer writing DataFusion SQL (R2 SQL) against an options market Iceberg lake.',
    '',
    'Schema:',
    schemaPrompt,
    '',
    'Rules:',
    '- To answer, ALWAYS write a read-only query (SELECT or WITH) and execute it with the run_query tool.',
    '- Use ONLY the table and column names in the Schema above. NEVER invent or guess identifiers — run_query validates your SQL against the real schema and will reject unknown tables/columns. If unsure, call check_schema on your SQL first.',
    '- Always end the top-level query with LIMIT (e.g. LIMIT 100). The backend caps rows anyway, but write your own LIMIT.',
    '- implied_vol is a decimal (0.25 = 25%). Moneyness ≈ (strike - spot) / spot.',
    '- The spot price column is `spot_price` (not `spot`). expiration is TEXT (use CAST(expiration AS DATE) for date math).',
    '- DTE: CAST(expiration AS DATE) - CURRENT_DATE returns integer days.',
    '- No OFFSET (unsupported). No named WINDOW clause (inline OVER (...) only).',
    '- WHERE must come before QUALIFY.',
    '- Prefer explicit column names over SELECT *.',
    '- The run_query tool returns a compact summary. If a query errors, fix it and call run_query again (a few attempts max).',
    '',
    'R2 SQL engine constraints (failures/timeouts here block your answer):',
    '- Read-only engine: only SELECT/WITH/DESCRIBE/SHOW/EXPLAIN are allowed; CROSS JOIN is rejected.',
    '- Expensive queries are budget-gated or time out: avoid joins of 3+ large tables with no WHERE filter, COUNT(DISTINCT x)/(DISTINCT) across joins or high-cardinality columns, ARRAY_AGG/STRING_AGG, and window functions over large partitions. Prefer WHERE filters + GROUP BY and the approx_* aggregates (approx_distinct, approx_median, approx_percentile_cont).',
    '- Filter before joining; join tables on keys (symbol, run_id) rather than scanning everything.',
    '',
    'Enrichment (why-is-it-moving / vol-context questions):',
    '- IV rank vs its own 90-day history is available via the iv_rank endpoint —',
    '  use it (/api/iv_rank?symbol=X&days=N, rank_pct in 0..1) when the user asks',
    '  if vol is rich or cheap.',
    '- Binary macro events (FOMC, CPI, jobs, PCE) lift broad vol — call',
    '  eco_calendar when the user asks about macro drivers or upcoming event',
    '  weeks before blaming a single name.',
    '- The lake has no news. When the user asks WHY something moved or why vol',
    '  is high, answer in up to three parts: (1) expensive or cheap: compare the',
    '  chain\'s implied_vol against options.realized_vol (latest per-symbol row:',
    '  realized_vol_30d / realized_vol_90d); (2) binary events: check',
    '  options.earnings for upcoming reports — earnings_date + time +',
    '  eps_forecast, roughly earnings_date BETWEEN CURRENT_DATE AND',
    '  CURRENT_DATE + 14;' +
      (freeMode
        ? ' (3) narrative: web search and news are unavailable in the free tier —' +
          '  explain the move from the data (realized vs implied vol, earnings,' +
          '  corporate actions) without claiming a headline or search source.'
        : ' (3) narrative: call get_news for the symbol(s) and' +
          '  cite the headlines you use.'),
    ...(freeMode
      ? [
          '- Web search and get_news are NOT available in the free tier — do not',
          '  call them; answer from the lake data and the tools you have.',
        ]
      : [
          '- For analyst/market commentary beyond one ticker (sector themes, macro',
          '  reactions, "what happened" questions), call web_search and cite the',
          '  links you use.',
        ]),
    '- options.corporate_actions holds historical dividends (amount, ex_date)',
    '  and splits — mention recent ones when relevant.',
    '',
    '- After you have the results, answer the user\'s question in plain English:',
    'mention specific symbols, sectors, and numbers where useful. If no rows were',
    'returned, say so and suggest a looser query. Be data-driven and conversational.',
    'Do NOT explain the SQL mechanics.',
    '',
    'Cached data (per-chat frames — do not re-pull what you already have):',
    '- When a question targets ONE symbol\'s data (chain, vol surface/smile, OI/IV profile),',
    '  materialize it ONCE with run_query, passing save_as with a descriptive name and',
    '  SELECTing a dte column (CAST(expiration AS DATE) - CURRENT_DATE AS dte) plus',
    '  spot_price (for moneyness/proximity math). askAi caches up to 5000 rows locally.',
    '- Follow-ups that narrow or re-shape that data ("only expirations <= 45 DTE", "20',
    '  strikes around spot", "calls only") MUST be answered with list_frames +',
    '  filter_frame on the cached frame — never a new lake query. Examples:',
    '    filter_frame { frame: "aapl_surface", where: "dte <= 45" }',
    '    filter_frame { frame: "aapl_surface", sort: "abs(strike - spot_price)", limit: 40 }',
    '- A frame holds only what its SQL selected. If the follow-up needs a column the frame',
    '  lacks (e.g. open_interest), run_query once more WITH save_as (same name replaces it).',
    '- list_frames shows each frame\'s columns and numeric min/max so you know what is',
    '  filterable locally. Frames expire after 15 min — on a stale-frame error, call',
    '  refresh_frame and retry the slice.',
    '',
    'Charting:',
    '- If the user asks for a chart (a stock chart, vol surface, IV smile/skew, OI/IV',
    '  profile, anything visual), you MUST call render_chart AFTER a run_query that',
    '  returned the chartable data — do not finish with just a table. There is no',
    '  historical price series in this lake, so "chart of a stock" means chart what IS',
    '  available for it: the IV smile (implied_vol vs strike), IV term structure, or',
    '  OI/IV profile by strike. SELECT the specific numeric columns you will chart.',
    '- Vol surface: x=strike, y=implied_vol, series=expiration.',
    '- IV smile: x=strike, y=implied_vol. OI/IV profile: x=strike, y=open_interest, series=type.',
    '- kind: `line` for curves/surfaces, `bar` for magnitudes, `scatter` for point clouds.',
    '- Give a short title and xLabel/yLabel when axis units help (yLabel="Implied vol"',
    '  for a 0-1 IV, xLabel="Strike"). Example: "Show the IV surface for AAPL" →',
    '  run_query with save_as: "aapl_surface" for strike, expiration, dte, implied_vol,',
    '  spot_price; then render_chart { title: "AAPL IV surface", kind: "line", x: "strike",',
    '    y: "implied_vol", series: "expiration" }. If the user then narrows the chart',
    '  ("only 45 DTE"), filter_frame the cached frame and render_chart again — no re-query.',
  ].join('\n');
}

async function runAgent(
  question: string,
  apiKey: string,
  model: string,
  schema: SchemaContext,
  session: ChatSession,
  capture: AgentCapture,
  freeMode: boolean,
  onStatus?: AskCallbacks['onStatus'],
  onProgress?: AskCallbacks['onProgress'],
): Promise<string> {
  const schemaPrompt = schemaToPrompt(schema);

  // Status-line updates flow through BOTH callbacks: the legacy onStatus
  // string channel (kept for back-compat) and the structured progress feed,
  // so the live panel sees every milestone.
  const emitStatus = (s: string) => {
    onStatus?.(s);
    onProgress?.({ kind: 'status', status: s });
  };

  const checkSchema = checkSchemaDef.server(async ({ sql }) => {
    const issues = validateSqlSchema(sql, schema);
    return {
      ok: issues.length === 0,
      issues: issues.map((i) => `[${i.severity}] ${i.message}`),
    };
  });

  const runQuery = runQueryDef.server(async ({ sql, save_as }) => {
    // Deterministic grounding: pre-validate identifiers against the real schema
    // so hallucinated tables/columns are rejected with a precise message BEFORE
    // hitting the backend. The agent loop then autocorrects and retries.
    const issues = validateSqlSchema(sql, schema);
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      const msg = errors.map((i) => i.message).join(' ');
      return { ok: false, error: msg, summary: `Schema validation failed: ${msg}` };
    }

    const materialize = !!save_as?.trim();
    emitStatus(materialize ? 'Running query & caching rows…' : 'Running query…');
    const res = await api.query(sql, materialize ? FRAME_QUERY_LIMIT : 200);
    capture.sql = sql;
    capture.result = res;
    if (res.error) {
      return { ok: false, error: res.error, summary: `Query failed: ${res.error}` };
    }
    let saved: DataFrame | null = null;
    if (materialize && res.row_count > 0) {
      const name = save_as!.trim();
      saved = {
        name,
        columns: res.columns,
        rows: res.rows,
        row_count: res.row_count,
        summary: buildFrameSummary(res.columns, res.rows),
        sql,
        fetched_at: Date.now(),
      };
      saveFrame(session.frames, saved);
    }
    const warnings = issues
      .filter((i) => i.severity === 'warning')
      .map((i) => i.message)
      .join(' ');
    let summary = warnings ? `Schema notes: ${warnings}\n${summarizeResult(res)}` : summarizeResult(res);
    if (saved) {
      summary +=
        `\nSaved frame '${saved.name}' (${saved.row_count} rows, ${saved.columns.length} cols). ` +
        (res.truncated
          ? 'WARNING: result was truncated at ' + res.limit + ' rows — the frame may be incomplete.'
          : 'Follow-ups can now filter it locally with filter_frame.');
    }
    return { ok: true, error: null, summary };
  });

  const listFrames = listFramesDef.server(async () => ({
    ok: true,
    error: null,
    summary: frameCatalogText(session.frames),
  }));

  const filterFrame = filterFrameDef.server(
    async ({ frame, where, sort, limit, project, save_as }) => {
      const f = session.frames.get(frame);
      if (!f) {
        return {
          ok: false,
          error: `No frame '${frame}'. Call list_frames to see cached frames, or materialize one with run_query save_as.`,
          summary: `No cached frame '${frame}'.`,
        };
      }
      if (Date.now() - f.fetched_at > FRAME_TTL_MS) {
        return {
          ok: false,
          error: `Frame '${frame}' is stale (cached ${frameAgeText(f)} ago; frames expire after ${Math.round(FRAME_TTL_MS / 60000)} min). Call refresh_frame { frame: '${frame}' } and retry.`,
          summary: `Frame '${frame}' is stale.`,
        };
      }
      try {
        const sliced = sliceFrame(f, { where, sort, limit, project });
        emitStatus('Filtering cached data…');
        const res: QueryResult = {
          columns: sliced.columns,
          rows: sliced.rows,
          row_count: sliced.row_count,
        };
        capture.result = res;
        capture.sql =
          `-- slice of cached frame '${f.name}'` +
          `${where ? ` where ${where}` : ''}${sort ? ` sorted by ${sort}` : ''}` +
          `${limit !== undefined ? ` limit ${limit}` : ''}${project ? ` project [${project.join(', ')}]` : ''}` +
          `\n-- source: ${f.sql}`;
        let summary = summarizeResult(res);
        if (save_as?.trim() && res.row_count > 0) {
          const name = save_as.trim();
          saveFrame(session.frames, {
            name,
            columns: res.columns,
            rows: res.rows,
            row_count: res.row_count,
            summary: buildFrameSummary(res.columns, res.rows),
            sql: f.sql,
            fetched_at: Date.now(),
          });
          summary += `\nSaved frame '${name}' (${res.row_count} rows).`;
        }
        return { ok: true, error: null, summary };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: msg,
          summary: `Filter failed: ${msg}. Check the where/sort expressions against the frame's columns.`,
        };
      }
    },
  );

  const refreshFrame = refreshFrameDef.server(async ({ frame }) => {
    const f = session.frames.get(frame);
    if (!f) {
      return {
        ok: false,
        error: `No frame '${frame}'. Call list_frames to see cached frames.`,
        summary: `No cached frame '${frame}'.`,
      };
    }
    emitStatus('Refreshing cached data…');
    const res = await api.query(f.sql, FRAME_QUERY_LIMIT);
    capture.sql = f.sql;
    capture.result = res;
    if (res.error) {
      return { ok: false, error: res.error, summary: `Refresh failed: ${res.error}` };
    }
    if (res.row_count > 0) {
      const updated: DataFrame = {
        name: f.name,
        columns: res.columns,
        rows: res.rows,
        row_count: res.row_count,
        summary: buildFrameSummary(res.columns, res.rows),
        sql: f.sql,
        fetched_at: Date.now(),
      };
      session.frames.set(f.name, updated);
    }
    return {
      ok: true,
      error: null,
      summary:
        `Refreshed frame '${f.name}' (${res.row_count} rows).` +
        (res.truncated ? ` WARNING: truncated at ${res.limit} rows — may be incomplete.` : ''),
    };
  });

  const renderChart = renderChartDef.server(async ({ x, y }) => {
    // The chart itself is rendered client-side from the captured tool input +
    // the last query result; this executor only needs to validate + let the
    // agent loop continue toward the natural-language answer.
    const result = capture.result;
    if (!result || result.error) {
      return {
        ok: false,
        error: 'No successful query result to chart. Call run_query (or filter_frame on a cached frame) first.',
      };
    }
    const cols = new Set(result.columns);
    if (!cols.has(x) || !cols.has(y)) {
      return {
        ok: false,
        error: `Result has no columns '${x}'/'${y}'. Available: ${result.columns.join(', ')}.`,
      };
    }
    return { ok: true, error: null };
  });

  const getNews = newsDef.server(async ({ symbol, limit }) => {
    const res = await api.news(symbol.trim().toUpperCase(), limit);
    if (res.error) {
      return { ok: false, summary: `News temporarily unavailable: ${res.error}` };
    }
    if (!res.items.length) {
      return { ok: true, summary: `No recent headlines found for ${res.symbol}.` };
    }
    return {
      ok: true,
      summary: res.items.map((n, i) => `${i + 1}. ${n.title} — ${n.link}`).join('\n'),
    };
  });

  const ecoCalendar = ecoCalendarDef.server(async ({ days }) => {
    const res = await api.econCalendar(days);
    if (res.error) {
      return { ok: false, summary: `Macro calendar temporarily unavailable: ${res.error}` };
    }
    if (!res.items.length) {
      return { ok: true, summary: 'No scheduled macro events in the requested window.' };
    }
    return {
      ok: true,
      summary: res.items.map((e, i) => `${i + 1}. ${e.date} — ${e.title}`).join('\n'),
    };
  });

  const webSearch = webSearchDef.server(async ({ query, max_results }) => {
    const res = await api.webSearch(query, max_results);
    if (res.error) {
      return { ok: false, summary: `Web search temporarily unavailable: ${res.error}` };
    }
    if (!res.results.length) {
      return { ok: true, summary: `No results found for "${res.query}".` };
    }
    return {
      ok: true,
      summary: res.results.map((r, i) => `${i + 1}. ${r.title} — ${r.link}`).join('\n'),
    };
  });

  const adapter = new ReasoningCompatibleTextAdapter(
    new OpenAI({
      // Free path: no browser key, so the request proxies through the Worker's
      // /api/free/v1 (site-key-funded, model allowlisted server-side) with a
      // dummy apiKey that the proxy drops. BYOK: the user's key goes straight
      // to OpenRouter — no server in that path could leak it.
      baseURL: freeMode ? `${API_BASE}/api/free/v1` : OPENROUTER_BASE,
      apiKey: freeMode ? 'free' : apiKey,
      // BYOK: the key is owned by the user, stored only in their browser, and
      // sent straight to OpenRouter — there is no server in this AI path that
      // could leak it. That is exactly the case `dangerouslyAllowBrowser` is for
      // (it disables the OpenAI SDK's default browser-key guard).
      dangerouslyAllowBrowser: true,
      defaultHeaders: {
        'HTTP-Referer': window.location.origin,
        'X-Title': APP_TITLE,
      },
    }),
    model,
    'openai-compatible',
  );

  // Thread prior turns of this chat (text only; data lives in the frames) so
  // follow-ups can refer to earlier results. Capped to bound token cost.
  const history = session.history.slice(-HISTORY_TURNS);
  const messages = [
    ...history.map((h, i) => ({
      id: `h${i}`,
      role: h.role as 'user' | 'assistant',
      parts: [{ type: 'text' as const, content: h.content }],
    })),
    {
      id: 'user',
      role: 'user' as const,
      parts: [{ type: 'text' as const, content: question }],
    },
  ];

  // Free tier excludes the metered Tavily tools (get_news / web_search hit our
  // Tavily key — free users must not burn the 1,000-credit monthly pool). The
  // cheap tools (FRED is keyless-free) stay.
  const tools = [
    runQuery, checkSchema, listFrames, filterFrame, refreshFrame, renderChart, ecoCalendar,
    ...(freeMode ? [] : [getNews, webSearch]),
  ];

  const stream = chat({
    adapter,
    messages,
    // systemPrompt is threaded via the `systemPrompts` option, NOT a system
    // message: TanStack AI's message conversion deliberately drops role:'system'
    // UIMessages and ModelMessage has no 'system' role.
    systemPrompts: [systemPrompt(schemaPrompt, freeMode)],
    tools,
    // More tools + multi-step slice/chart workflows need a slightly larger budget.
    agentLoopStrategy: maxIterations(10),
    modelOptions: {
      temperature: 0.2,
      // Only send reasoning_effort to models the catalog says support it —
      // OpenRouter rejects unsupported parameters.
      ...(modelSupports(model, 'reasoning_effort')
        ? { reasoning_effort: getEffort() }
        : {}),
    },
    stream: true,
  });

  // The final assistant text comes after the last tool call; drop any text the
  // model emitted before deciding to call a tool.
  let answer = '';
  // toolCallId -> tool name, so args/end events (which only carry the id) can
  // resolve the label — including when parallel calls stream interleaved.
  const toolNameById = new Map<string, string>();
  // toolCallId -> accumulated argument text. TOOL_CALL_ARGS deltas arrive as
  // partial JSON chunks, so the preview must be built up per call.
  const toolArgsById = new Map<string, string>();
  // Reasoning is streamed live via REASONING_MESSAGE_CONTENT when the adapter
  // supports it; STEP_FINISHED (thinking-step deltas) is only a fallback so a
  // model that emits both never double-renders the same tokens.
  let sawReasoning = false;
  // Tool-args deltas are throttled so a long JSON stream doesn't re-render the
  // row on every token; ~120ms is smooth without being chatty.
  let lastArgsEmitAt = 0;
  // 'answer' marks the start of the final text (after the last tool call).
  let sawToolEnd = false;
  let notifiedAnswer = false;
  const emitToolEnd = (callId: string, name: string, ok: boolean, summary: string) => {
    onProgress?.({ kind: 'tool_end', name, callId, ok, summary });
  };
  // The engine delivers execution outcomes as TOOL_CALL_RESULT with the
  // validated tool output JSON-stringified into `content` ({ok, summary,
  // error} per the outputSchema) — parse it back for the feed row.
  const toolEndFromResult = (callId: string, content: unknown, state: unknown) => {
    const name = toolNameById.get(callId) ?? '';
    let ok = state !== 'output-error';
    let summary = '';
    if (typeof content === 'string') {
      try {
        const parsed: unknown = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && 'ok' in parsed && typeof parsed.ok === 'boolean') {
          ok = parsed.ok;
        }
        if (parsed && typeof parsed === 'object' && 'summary' in parsed && typeof parsed.summary === 'string') {
          summary = parsed.summary;
        }
      } catch {
        summary = content;
      }
      if (!summary) summary = content;
    }
    emitToolEnd(callId, name, ok, summary);
  };
  for await (const ev of stream) {
    if (ev.type === 'TOOL_CALL_START') {
      const name = evToolName(ev) ?? '';
      if (name) toolNameById.set(ev.toolCallId, name);
      onProgress?.({
        kind: 'tool_start',
        name,
        display: TOOL_LABELS[name] ?? humanizeTool(name),
        callId: ev.toolCallId,
      });
    } else if (ev.type === 'TOOL_CALL_ARGS') {
      toolArgsById.set(ev.toolCallId, (toolArgsById.get(ev.toolCallId) ?? '') + ev.delta);
      const now = Date.now();
      if (now - lastArgsEmitAt >= TOOL_ARGS_THROTTLE_MS) {
        lastArgsEmitAt = now;
        onProgress?.({
          kind: 'tool_args',
          name: toolNameById.get(ev.toolCallId) ?? '',
          callId: ev.toolCallId,
          args: toolArgsById.get(ev.toolCallId) ?? '',
        });
      }
    } else if (ev.type === 'TOOL_CALL_END') {
      const name = toolNameById.get(ev.toolCallId) ?? evToolName(ev) ?? '';
      // Capture a chart spec the model declared, paired with the last result,
      // so the UI can render it alongside the answer. Only keep text emitted
      // after the last tool call (the final answer).
      // Some adapters emit the tool name on `toolName` (deprecated) rather than
      // `toolCallName`, and `input` may arrive as a JSON string — accept any of
      // these so capture never silently drops a requested chart.
      if (name === 'render_chart') {
        let input: unknown = ev.input;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* keep raw */ }
        }
        if (input && typeof input === 'object') {
          const c = input as Partial<ChartSpec>;
          if (typeof c.x === 'string' && typeof c.y === 'string') {
            capture.chart = { kind: c.kind ?? 'line', ...input } as ChartSpec;
          }
        }
      }
      // The engine's DECLARATION TOOL_CALL_END carries no outcome — the
      // result arrives on TOOL_CALL_RESULT below. Some engine paths do attach
      // the validated output to this event; accept that defensively.
      const out = ev.output;
      if (out && typeof out === 'object' && 'ok' in out && typeof out.ok === 'boolean') {
        let summary = '';
        if ('summary' in out && typeof out.summary === 'string') summary = out.summary;
        emitToolEnd(ev.toolCallId, name, out.ok, summary);
      }
      answer = '';
      sawToolEnd = true;
    } else if (ev.type === 'TOOL_CALL_RESULT') {
      toolEndFromResult(ev.toolCallId, ev.content, ev.state);
    } else if (ev.type === 'REASONING_MESSAGE_CONTENT' && typeof ev.delta === 'string' && ev.delta) {
      sawReasoning = true;
      onProgress?.({ kind: 'reasoning', delta: ev.delta });
    } else if (ev.type === 'STEP_FINISHED' && !sawReasoning) {
      // Fallback thinking blocks for adapters that don't surface reasoning
      // deltas — only until real reasoning content takes over.
      const chunk = typeof ev.delta === 'string' ? ev.delta : typeof ev.content === 'string' ? ev.content : '';
      if (chunk) onProgress?.({ kind: 'reasoning', delta: chunk });
    } else if (ev.type === 'TEXT_MESSAGE_CONTENT' && typeof ev.delta === 'string') {
      if (sawToolEnd && !notifiedAnswer) {
        notifiedAnswer = true;
        onProgress?.({ kind: 'answer' });
      }
      answer += ev.delta;
    } else if (ev.type === 'RUN_ERROR') {
      onProgress?.({ kind: 'error', message: ev.message || 'The model request failed.' });
      throw new Error(ev.message || 'The model request failed.');
    }
  }
  return answer.trim();
}

// ---------------------------------------------------------------------------
// Public pipeline: ask a question → get answer + SQL + result
// ---------------------------------------------------------------------------
// Live progress events streamed to the UI while the agent loop runs: status
// milestones, live reasoning tokens, and the tool feed (start → streaming
// args → end with ok/summary). The 'answer' event marks the start of the
// final text and 'error' a failed run.
export type AgentProgress =
  | { kind: 'status'; status: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'tool_start'; name: string; display: string; callId: string }
  | { kind: 'tool_args'; name: string; callId: string; args: string }
  | { kind: 'tool_end'; name: string; callId: string; ok: boolean; summary: string }
  | { kind: 'answer' }
  | { kind: 'error'; message: string };

// Human-facing tool labels for the progress feed.
const TOOL_LABELS: Record<string, string> = {
  run_query: 'SQL query',
  check_schema: 'Check schema',
  list_frames: 'List frames',
  filter_frame: 'Filter frame',
  refresh_frame: 'Refresh frame',
  render_chart: 'Render chart',
  get_news: 'News',
  eco_calendar: 'Eco calendar',
  web_search: 'Web search',
};

const humanizeTool = (name: string): string => TOOL_LABELS[name] ?? name.replaceAll('_', ' ');

// Tool-args deltas are throttled to ~120ms — smooth streaming without a
// re-render per token.
const TOOL_ARGS_THROTTLE_MS = 120;

/** Resolve a tool name from a stream event, honoring the deprecated alias. */
function evToolName(ev: { toolCallName?: unknown; toolName?: unknown }): string | undefined {
  const n = ev.toolCallName ?? ev.toolName;
  return typeof n === 'string' ? n : undefined;
}

/**
 * The site's free-chat credit ran out (Worker 402 free_credit_exhausted).
 * The UI pivots to the BYOK connect gate instead of showing a generic failure.
 */
export class FreeCreditExhausted extends Error {
  constructor(message = "Free credit's out — connect OpenRouter to keep chatting") {
    super(message);
    this.name = 'FreeCreditExhausted';
  }
}

/** True for a 402 credit-exhausted failure from the free proxy (any shape). */
function isCreditExhaustedError(e: unknown): boolean {
  if (e && typeof e === 'object' && 'status' in e && e.status === 402) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('free_credit_exhausted') || msg.includes('402');
}

export interface AskCallbacks {
  onStatus?: (status: string) => void;
  onProgress?: (p: AgentProgress) => void;
}

export interface AskResult {
  answer: string;
  sql: string | null;
  result: QueryResult | null;
  /** Chart the model asked to render (paired with `result`), or null. */
  chart: ChartSpec | null;
}

export async function askAi(
  question: string,
  session: ChatSession,
  opts: AskCallbacks = {},
): Promise<AskResult> {
  const apiKey = getApiKey();
  // No browser key → free chat on the site's OpenRouter credit, proxied by the
  // Worker (/api/free/v1). BYOK users never touch the free path.
  const freeMode = !apiKey;
  // Free path ignores the model picker: the proxy pins + re-validates FREE_MODEL.
  const model = freeMode ? FREE_MODEL : getModel();
  const capture: AgentCapture = { sql: null, result: null, chart: null };

  const emitStatus = (s: string) => {
    opts.onStatus?.(s);
    opts.onProgress?.({ kind: 'status', status: s });
  };

  emitStatus('Reading schema…');
  let schema: SchemaContext;
  try {
    schema = await buildSchemaContext();
  } catch (e) {
    throw new Error(`Failed to read schema: ${e}`);
  }

  emitStatus('Reasoning over the data…');
  let answer: string;
  try {
    answer = await runAgent(question, apiKey, model, schema, session, capture, freeMode, opts.onStatus, opts.onProgress);
  } catch (e) {
    // 402 free_credit_exhausted must always surface — even mid-chat after a
    // successful tool call — so the UI pivots to the connect gate.
    if (freeMode && isCreditExhaustedError(e)) throw new FreeCreditExhausted();
    // If the agent itself errored but a query already ran, still surface the
    // (partial) result rather than dropping it.
    if (capture.result) {
      answer = `The query ran but the model did not finish an answer: ${e}`;
    } else {
      throw e;
    }
  }

  // Memory for the next turn: text history (threaded as messages) is appended
  // here; frames are already in session.frames (mutated by the tools).
  session.history.push({ role: 'user', content: question });
  session.history.push({ role: 'assistant', content: answer });
  if (session.history.length > HISTORY_TURNS * 2) {
    session.history.splice(0, session.history.length - HISTORY_TURNS * 2);
  }

  return { answer, sql: capture.sql, result: capture.result, chart: capture.chart };
}
