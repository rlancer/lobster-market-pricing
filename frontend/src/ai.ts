// AI copilot for the options screener.
// Runs entirely client-side: the user's OpenRouter API key is stored in
// localStorage and sent directly from the browser to OpenRouter — no
// backend proxy, no per-user billing for the site owner.
//
// Flow per question:
//   1. Gather schema context (tables, columns, types, sample rows).
//   2. Call OpenRouter with a system prompt to generate DuckDB SQL.
//   3. Execute the SQL against the local DuckDB-WASM instance.
//   4. If SQL errors, ask the model to fix it (up to 2 retries).
//   5. Summarise the result and ask the model to interpret in plain English.
//   6. Return { answer, sql, result }.

import { api } from './api';
import type { QueryResult } from './api';

// ---------------------------------------------------------------------------
// Credential / model helpers (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'openinterest_ai_key';
const MODEL_KEY = 'openinterest_ai_model';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

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
  const callbackUrl = `${window.location.origin}${window.location.pathname}?${OAUTH_CALLBACK_PARAM}=1`;
  const authUrl =
    'https://openrouter.ai/auth?' +
    `callback_url=${encodeURIComponent(callbackUrl)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    '&code_challenge_method=S256';
  window.location.href = authUrl;
}

/** Detect whether the current URL is an OpenRouter OAuth callback. */
export function isOAuthCallback(): boolean {
  return new URLSearchParams(window.location.search).get(OAUTH_CALLBACK_PARAM) === '1';
}

/**
 * If the current URL is an OAuth callback, exchange the `code` for an API key,
 * store it, strip the callback params from the URL, and return true.
 * Returns false if there is no callback to handle.
 */
export async function handleOAuthCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  if (params.get(OAUTH_CALLBACK_PARAM) !== '1') return false;

  const code = params.get('code');
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
  return true;
}

// ---------------------------------------------------------------------------
// Schema context builder
// ---------------------------------------------------------------------------
export interface SchemaTable {
  name: string;
  columns: { name: string; type: string }[];
  sample: Record<string, unknown>[];
}
export interface SchemaContext {
  tables: SchemaTable[];
}

export async function buildSchemaContext(): Promise<SchemaContext> {
  const tables = await api.tables();
  const out: SchemaTable[] = [];
  for (const t of tables) {
    let sample: Record<string, unknown>[] = [];
    try {
      const r = await api.query(`SELECT * FROM "${t.name}" LIMIT 3`, 3);
      sample = r.rows;
    } catch {
      /* non-fatal: sample is optional */
    }
    out.push({ name: t.name, columns: t.columns, sample });
  }
  return { tables: out };
}

function schemaToPrompt(ctx: SchemaContext): string {
  return ctx.tables
    .map((t) => {
      const cols = t.columns.map((c) => `    ${c.name} ${c.type}`).join('\n');
      const sample = t.sample.length
        ? '  sample rows:\n' +
          t.sample.map((r) => '    ' + JSON.stringify(r)).join('\n')
        : '';
      return `TABLE ${t.name}\n  columns:\n${cols}${sample}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// OpenRouter Chat Completions
// ---------------------------------------------------------------------------
async function chatCompletion(opts: {
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Open Interest Options Workspace',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
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
    throw new Error(`OpenRouter error (${res.status}): ${detail}`);
  }

  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned an empty response.');
  }
  return content;
}

// ---------------------------------------------------------------------------
// SQL extraction from model response
// ---------------------------------------------------------------------------
function extractSql(text: string): string | null {
  // Prefer a ```sql … ``` fence.
  const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fence) {
    const s = fence[1].trim();
    if (/^(SELECT|WITH|DESCRIBE|SHOW|PRAGMA|EXPLAIN)\b/i.test(s)) return s;
  }
  // Fallback: treat the whole response as SQL if it starts with a read-only
  // keyword.
  const stripped = text.trim().replace(/;+\s*$/, '').trim();
  if (/^(SELECT|WITH|DESCRIBE|SHOW|PRAGMA|EXPLAIN)\b/i.test(stripped)) return stripped;
  return null;
}

// ---------------------------------------------------------------------------
// Result summariser (compact text for the interpretation prompt)
// ---------------------------------------------------------------------------
function summarizeResult(res: QueryResult): string {
  const { columns, rows, row_count } = res;
  const lines: string[] = [`Columns: ${columns.join(', ')}`, `Row count: ${row_count}`];
  const shown = rows.slice(0, 50);
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
    if (rows.length > 50) lines.push(`  … (showing 50 of ${row_count} rows)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Individual model calls
// ---------------------------------------------------------------------------
async function generateSql(
  question: string,
  schemaPrompt: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const system = [
    'You are a senior quant developer writing DuckDB SQL against an options market dataset.',
    '',
    'Schema:',
    schemaPrompt,
    '',
    'Rules:',
    '- Write ONE read-only query (SELECT or WITH).',
    '- Use the exact table and column names from the schema.',
    '- implied_vol is a decimal (0.25 = 25%). Moneyness ≈ (strike - spot) / spot.',
    '- Prefer explicit column names over SELECT *.',
    '- Respond with ONLY the SQL inside a markdown ```sql code fence. No prose, no explanation.',
  ].join('\n');

  return chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Answer this question with a DuckDB query:\n${question}` },
    ],
    temperature: 0.1,
    maxTokens: 800,
  });
}

async function fixSql(
  question: string,
  schemaPrompt: string,
  previousSql: string,
  error: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const system = [
    'You write read-only DuckDB SQL for an options dataset.',
    '',
    'Schema:',
    schemaPrompt,
    '',
    'Your previous query failed with an error. Rewrite it to fix the error.',
    'Return ONLY the corrected SQL inside a markdown ```sql code fence. No prose.',
  ].join('\n');

  return chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Question: ${question}\n\nFailing SQL:\n${previousSql}\n\nError:\n${error}`,
      },
    ],
    temperature: 0.1,
    maxTokens: 800,
  });
}

async function interpret(
  question: string,
  sql: string,
  summary: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const system = [
    'You are a friendly, concise options-analytics assistant.',
    'The user asked a question, and a DuckDB query ran locally against their options dataset.',
    'Explain the findings in plain, natural language.',
    'Mention specific symbols, sectors, and numbers where useful.',
    'If no rows were returned, say so and suggest a looser query.',
    'Be data-driven and conversational. Do NOT explain the SQL mechanics.',
  ].join('\n');

  return chatCompletion({
    apiKey,
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `User question:\n${question}\n\nQuery executed:\n${sql}\n\nResult summary:\n${summary}`,
      },
    ],
    temperature: 0.4,
    maxTokens: 700,
  });
}

// ---------------------------------------------------------------------------
// Public pipeline: ask a question → get answer + SQL + result
// ---------------------------------------------------------------------------
export interface AskCallbacks {
  onStatus?: (status: string) => void;
}

export interface AskResult {
  answer: string;
  sql: string | null;
  result: QueryResult | null;
}

export async function askAi(
  question: string,
  opts: AskCallbacks = {},
): Promise<AskResult> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key configured. Set it in the settings panel first.');

  const model = getModel();

  // --- Step 1: Schema ---
  opts.onStatus?.('Reading schema…');
  let schemaPrompt: string;
  try {
    schemaPrompt = schemaToPrompt(await buildSchemaContext());
  } catch (e) {
    throw new Error(`Failed to read schema: ${e}`);
  }

  // --- Step 2: Generate SQL ---
  opts.onStatus?.('Designing SQL query…');
  let sql = extractSql(await generateSql(question, schemaPrompt, apiKey, model));

  // --- Step 3: Execute + auto-fix loop ---
  let result: QueryResult | null = null;
  let attempts = 0;
  while (!result && attempts < 3) {
    if (!sql) {
      return {
        answer: 'I could not generate a valid SQL query from your question. Try rephrasing it.',
        sql: null,
        result: null,
      };
    }

    opts.onStatus?.(`Running query${attempts > 0 ? ` (attempt ${attempts + 1})` : ''}…`);
    const res = await api.query(sql, 200);
    if (res.error) {
      attempts++;
      if (attempts >= 3) {
        result = res;
        break;
      }
      opts.onStatus?.('Fixing query…');
      sql = extractSql(await fixSql(question, schemaPrompt, sql, res.error, apiKey, model));
    } else {
      result = res;
    }
  }

  // --- Step 4: Interpret ---
  opts.onStatus?.('Interpreting results…');
  let summary: string;
  let answer: string;
  if (result?.error) {
    summary = `Query failed: ${result.error}`;
    answer = `The query ran into an error:\n\n> ${result.error}\n\nyou could try rephrasing your question.`;
  } else if (result) {
    summary = summarizeResult(result);
    try {
      answer = await interpret(question, sql ?? '', summary, apiKey, model);
    } catch {
      // Fallback: provide a simple table summary if the model call fails.
      answer = `The query returned **${result.row_count} row${result.row_count !== 1 ? 's' : ''}** with ${result.columns.length} columns: ${result.columns.join(', ')}.`;
    }
  } else {
    answer = 'No results were returned. Try a different question.';
  }

  return { answer, sql, result };
}