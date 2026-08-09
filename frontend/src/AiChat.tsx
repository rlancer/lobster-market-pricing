import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import './AiChat.css';
import {
  Button,
  ChatComposer,
  ChatMessageMetadata,
  ChatSendButton,
  IconButton,
  Markdown,
  Selector,
  Spinner,
  Timestamp,
  Tooltip,
  useChatStreamScroll,
} from '@astryxdesign/core';
import { Settings, SquarePen } from 'lucide-react';
import { type QueryResult } from './api';
import { OpenRouterLogo } from './OpenRouterLogo';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { ChartView, type ChartSpec } from './Chart';
import {
  askAi,
  clearApiKey,
  createSession,
  FALLBACK_MODEL_GROUPS,
  fetchAvailableModels,
  getApiKey,
  getEffort,
  getModel,
  handleOAuthCallback,
  isOAuthCallback,
  modelHasParams,
  modelSupports,
  setApiKey,
  setEffort,
  setModel,
  startOAuthFlow,
  type AgentProgress,
  type ChatSession,
  type DataFrame,
  type ModelGroup,
  type ReasoningEffort,
} from './ai';

const EFFORT_OPTIONS: { value: ReasoningEffort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

// Model options come from OpenRouter's /models catalog (tool-capable, recent),
// fetched on mount. The chat state (localStorage) can hold any model id a user
// chose before, so the rendered options always merge the active model back in —
// the selector must never drop it. Returns section-shaped options for Selector.
function ensureModelPresent(groups: ModelGroup[], model: string) {
  const sections = groups.map((g) => ({
    type: 'section' as const,
    title: g.title,
    options: g.options,
  }));
  const known = groups.flatMap((g) => g.options.map((o) => o.value));
  if (model && !known.includes(model)) {
    sections.push({ type: 'section', title: 'Custom', options: [{ value: model, label: model }] });
  }
  return sections;
}

const EXAMPLES = [
  'Find the most liquid calls expiring within 30 days',
  'Which sectors have the richest put premiums?',
  'Chart the IV smile for NVDA',
  'What underlyings have the most open interest?',
];

const uid = () => Math.random().toString(36).slice(2);

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  error?: string;
  /** Epoch ms when the message was produced. */
  ts?: number;
  /** Model that answered (assistant only). */
  model?: string;
}

/** One row in the live tool feed inside the busy bubble. */
interface ToolRow {
  /** Stream toolCallId — stable per call, so repeated tools stay distinct rows. */
  callId: string;
  name: string;
  display: string;
  args: string;
  /** null while running; true/false once the tool ended. */
  ok: boolean | null;
  summary: string;
}

/** Immutably apply a patch to the row with `callId` (no-op when absent). */
function patchTool(tools: ToolRow[], callId: string, patch: Partial<ToolRow>): ToolRow[] {
  const i = tools.findIndex((t) => t.callId === callId);
  if (i === -1) return tools;
  return tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(v);
}

// Frames can hold thousands of rows (materialized chains); rendering them all
// would swamp the DOM. Show the first batch; the full result stays in session.
const MAX_RENDER_ROWS = 200;

function ResultTable({ result }: { result: QueryResult }) {
  if (result.error) {
    return <div className="ai-err">Query error: {result.error}</div>;
  }
  if (!result.columns.length) {
    return <div className="ai-empty">Query returned no columns.</div>;
  }
  const shown = result.rows.slice(0, MAX_RENDER_ROWS);
  return (
    <div className="ai-result">
      <div className="ai-result-meta">
        <b>{result.row_count.toLocaleString()}</b> rows · {result.columns.length} columns
        {result.truncated ? ` · first ${result.limit}` : ''}
      </div>
      <div className="ai-result-scroll">
        <table className="ai-result-table">
          <thead>
            <tr>
              <th className="ai-idx">#</th>
              {result.columns.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                <td className="ai-idx">{i + 1}</td>
                {result.columns.map((c) => <td key={c}>{fmtCell(row[c])}</td>)}
              </tr>
            ))}
            {result.row_count > shown.length && (
              <tr>
                <td colSpan={result.columns.length + 1} className="ai-empty">
                  … {result.row_count - shown.length} more rows (full result cached in session data)
                </td>
              </tr>
            )}
            {shown.length === 0 && (
              <tr><td colSpan={result.columns.length + 1} className="ai-empty">No rows returned.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };
  return (
    <Tooltip content="Copy SQL" hasHoverIndication={false}>
      <button type="button" className="ai-sql-copy" onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </Tooltip>
  );
}

function AiChat() {
  const [key, setKeyState] = useState(getApiKey());
  const [model, setModelState] = useState(getModel());
  const [effort, setEffortState] = useState<ReasoningEffort>(getEffort());
  // Live OpenRouter catalog (tool-capable, recent) + loading flag for the Selector.
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>(FALLBACK_MODEL_GROUPS);
  const [modelsLoading, setModelsLoading] = useState(false);
  // Keep the chat front-and-center on load; the connect flow lives in the
  // welcome empty-state (see below) instead of forcing a big form open.
  const [showSettings, setShowSettings] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Live agent progress: streamed reasoning tokens + the tool feed, shown in
  // the busy bubble and reset per question.
  const [reasoning, setReasoning] = useState('');
  const [writing, setWriting] = useState(false);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Per-chat data cache ("frames"): named snapshots of query results the agent
  // materializes (run_query save_as) and slices locally (filter_frame). Holds
  // the mutable session; `frames` mirrors it for the chips UI.
  const [session] = useState<ChatSession>(() => createSession());
  const [frames, setFrames] = useState<DataFrame[]>([]);

  const syncFrames = useCallback(() => {
    setFrames(Array.from(session.frames.values()).reverse());
  }, [session]);
  const dropFrame = useCallback((name: string) => {
    session.frames.delete(name);
    syncFrames();
  }, [session, syncFrames]);

  // Process an OpenRouter OAuth callback if the page loaded with one.
  useEffect(() => {
    if (!isOAuthCallback()) return;
    setOauthBusy(true);
    handleOAuthCallback()
      .then((handled) => {
        if (handled) {
          setKeyState(getApiKey());
          setShowSettings(false);
          setError(null);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setOauthBusy(false));
  }, []);

  // Load the live OpenRouter model catalog once. On failure keep the empty
  // fallback (the header/settings still work; the user's stored model is
  // always merged back in by ensureModelPresent).
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    fetchAvailableModels()
      .then((groups) => {
        if (!cancelled) setModelGroups(groups);
      })
      .catch(() => {
        /* fall back to empty; stored model stays selected */
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    setOauthBusy(true);
    setError(null);
    try {
      await startOAuthFlow(); // redirects away; only returns on failure
    } catch (e) {
      setError(String(e));
      setOauthBusy(false);
    }
  };

  const { scrollIfLocked } = useChatStreamScroll({ scrollRef });
  useEffect(() => {
    scrollIfLocked();
  }, [scrollIfLocked, msgs, busy, status, reasoning]);

  // Keep the streaming Thinking block pinned to the newest tokens.
  useEffect(() => {
    const el = thinkingRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [reasoning]);

  const saveKey = () => {
    setApiKey(key);
    setShowSettings(false);
    setError(null);
  };
  const saveModel = (m: string) => {
    setModel(m);
    setModelState(m);
  };
  const saveEffort = (e: ReasoningEffort) => {
    setEffort(e);
    setEffortState(e);
  };
  const resetKey = () => {
    clearApiKey();
    setKeyState('');
    setShowSettings(true);
  };

  const send = useCallback(async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    if (!getApiKey()) {
      setShowSettings(true);
      setError('Add your OpenRouter API key to get started — it stays in your browser.');
      return;
    }
    setInput('');
    setError(null);
    // Fresh progress panel per question.
    setReasoning('');
    setWriting(false);
    setTools([]);
    const now = Date.now();
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: question, ts: now }]);
    setBusy(true);
    setStatus('Starting…');
    try {
      const res = await askAi(question, session, {
        onStatus: setStatus,
        onProgress: (p: AgentProgress) => {
          switch (p.kind) {
            case 'status':
              setStatus(p.status);
              break;
            case 'reasoning':
              setReasoning((r) => r + p.delta);
              break;
            case 'tool_start':
              setTools((ts) => [
                ...ts,
                { callId: p.callId, name: p.name, display: p.display, args: '', ok: null, summary: '' },
              ]);
              break;
            case 'tool_args':
              setTools((ts) => patchTool(ts, p.callId, { args: p.args }));
              break;
            case 'tool_end':
              setTools((ts) => patchTool(ts, p.callId, { ok: p.ok, summary: p.summary }));
              break;
            case 'answer':
              setWriting(true);
              setStatus('Writing answer…');
              break;
            case 'error':
              setStatus('Something went wrong');
              break;
          }
        },
      });
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: res.answer, sql: res.sql, result: res.result, chart: res.chart, ts: Date.now(), model: getModel() },
      ]);
      syncFrames();
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: '', error: String(e), ts: Date.now() },
      ]);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }, [busy, session, syncFrames]);

  const newChat = () => {
    session.frames.clear();
    session.history.length = 0;
    setFrames([]);
    setMsgs([]);
    setError(null);
  };

  const openExplorerSql = (sql: string) => {
    // Route to the SQL Lab with the SQL carried in the `sql` search param;
    // the Explorer route reads and runs it on mount.
    navigate({ to: '/lab', search: { sql } });
  };

  // Effort only applies to models the catalog confirms accept reasoning_effort.
  // Leave it enabled while loading (params not known yet) and for unknown/custom
  // models; disable it only when we definitively know the model lacks the param.
  const effortDisabled =
    !modelsLoading && modelHasParams(model) && !modelSupports(model, 'reasoning_effort');
  const effortDisabledMessage = effortDisabled
    ? "This model doesn't support reasoning effort."
    : undefined;

  return (
    <section className="ai-chat">
      <header className="ai-head" aria-label="Chat controls">
        <section className="ai-head-actions">
          <Tooltip content={getApiKey() ? 'OpenRouter connected' : 'OpenRouter not connected'} hasHoverIndication={false}>
            <span className={`ai-key-dot ${getApiKey() ? 'ok' : ''}`} />
          </Tooltip>
          <span className="ai-head-model">
            <Selector
              label="Model"
              size="sm"
              isLabelHidden
              hasSearch
              isLoading={modelsLoading}
              searchPlaceholder="Search models…"
              width={236}
              options={ensureModelPresent(modelGroups, model)}
              value={model}
              onChange={(m) => { if (m) saveModel(m); }}
            />
          </span>
          <IconButton variant="ghost" size="sm" label="Settings" icon={<Settings size={16} />} tooltip="Settings" onClick={() => setShowSettings((s) => !s)} />
          <IconButton variant="ghost" size="sm" label="New chat" icon={<SquarePen size={16} />} tooltip="New chat" onClick={newChat} />
        </section>
      </header>

      {showSettings && (
        <div className="ai-settings">
          <div className="ai-settings-connect">
            <span className="or-badge" aria-hidden="true">
              <OpenRouterLogo width={32} height={24} color="var(--color-accent)" />
            </span>
            <span className="ai-settings-label">
              <b>Sign in with OpenRouter</b>
              <em>Use any model in one place — no manual key needed.</em>
            </span>
            <button className="ai-connect-btn" onClick={connect} disabled={oauthBusy}>
              {oauthBusy ? 'Connecting…' : 'Continue with OpenRouter'}
            </button>
          </div>
          <div className="ai-settings-divider"><span>or paste a key manually</span></div>
          <div className="ai-settings-row">
            <label>
              <span>OpenRouter API key <em className="ai-local">stored locally in your browser</em></span>
              <div className="ai-key-input">
                <input
                  type="password"
                  value={key}
                  placeholder="sk-or-v1-…"
                  spellCheck={false}
                  onChange={(e) => setKeyState(e.target.value)}
                />
                <button className="ai-save" onClick={saveKey} disabled={!key.trim()}>Save</button>
                {getApiKey() && (
                  <button className="ai-ghost ai-remove" onClick={resetKey}>Remove</button>
                )}
              </div>
            </label>
            <Selector
              label="Model"
              size="md"
              hasSearch
              isLoading={modelsLoading}
              searchPlaceholder="Search models…"
              options={ensureModelPresent(modelGroups, model)}
              value={model}
              onChange={(m) => { if (m) saveModel(m); }}
              className="ai-settings-model"
            />
            <Selector
              label="Reasoning effort"
              size="md"
              isDisabled={effortDisabled}
              disabledMessage={effortDisabledMessage}
              options={EFFORT_OPTIONS}
              value={effort}
              onChange={(e) => { if (e) saveEffort(e as ReasoningEffort); }}
              className="ai-settings-effort"
            />
          </div>
        </div>
      )}

      {error && <div className="ai-error-banner">{error}</div>}

      {frames.length > 0 && (
        <div className="ai-frames">
          <span className="ai-frames-label">Session data</span>
          {frames.map((f) => {
            const ageMin = Math.round((Date.now() - f.fetched_at) / 60000);
            return (
              <Tooltip
                key={f.name}
                content={`${f.row_count.toLocaleString()} rows · ${f.columns.length} cols · ${f.sql}`}
                hasHoverIndication={false}
              >
                <span className="ai-frame-chip">
                  <b>{f.name}</b>
                  <span className="ai-frame-meta">
                    {f.row_count.toLocaleString()}r · {ageMin < 1 ? 'fresh' : `${ageMin}m`}
                  </span>
                  <button
                  type="button"
                  className="ai-frame-drop"
                  onClick={() => dropFrame(f.name)}
                  aria-label={`Drop frame ${f.name}`}
                >
                  ✕
                </button>
                </span>
              </Tooltip>
            );
          })}
        </div>
      )}

      <section className="ai-messages" ref={scrollRef}>
        {msgs.length === 0 && (
          <section className="ai-welcome">
            <header className="ai-welcome-hero">
              <BlueLobsterLogo className="ai-welcome-mascot" />
              <h1 className="ai-welcome-title">Ask the Lobster</h1>
              <span className="ai-welcome-kicker">Research your options data</span>
              <p>Chat writes the SQL, runs it against your dataset, and returns the answer.</p>
            </header>
            <nav className="ai-examples" aria-label="Suggested questions">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="ai-example-card" onClick={() => send(ex)} disabled={busy}>
                  <span>{ex}</span>
                  <span className="ai-example-arrow" aria-hidden="true">↗</span>
                </button>
              ))}
            </nav>
            {!getApiKey() && (
              <section className="ai-welcome-connect" aria-label="Connect OpenRouter">
                <p><b>Connect OpenRouter</b> to ask your first question.</p>
                <button className="ai-connect-btn" onClick={connect} disabled={oauthBusy}>
                  {oauthBusy ? 'Connecting…' : 'Connect'}
                </button>
              </section>
            )}
          </section>
        )}

        {msgs.map((m) => (
          <div key={m.id} className={`ai-msg ai-${m.role}`}>
            {m.role === 'assistant' && (
              <span className="ai-msg-mark" aria-hidden="true">λ</span>
            )}
            <div className="ai-bubble">
              {m.error ? (
                <div className="ai-err">{m.error}</div>
              ) : (
                <>
                  {m.content && (
                    m.role === 'assistant'
                      ? <div className="ai-text"><Markdown>{m.content}</Markdown></div>
                      : <div className="ai-text">{m.content}</div>
                  )}
                  {m.sql && (
                    <div className="ai-sql">
                      <div className="ai-sql-head">
                        <span>SQL</span>
                        <span className="ai-sql-actions">
                          <CopyButton text={m.sql} />
                          <Tooltip content="Open in SQL Lab" hasHoverIndication={false}>
                            <button
                              onClick={() => openExplorerSql(m.sql!)}
                            >
                              Open in SQL Lab ↗
                            </button>
                          </Tooltip>
                        </span>
                      </div>
                      <pre>{m.sql}</pre>
                    </div>
                  )}
                  {m.result && <ResultTable result={m.result} />}
                  {m.chart && m.result && <ChartView result={m.result} spec={m.chart} />}
                  {m.role === 'assistant' && (m.ts !== undefined || m.model) && (
                    <ChatMessageMetadata
                      timestamp={m.ts !== undefined ? <Timestamp value={m.ts / 1000} format="time" /> : undefined}
                      footer={m.model}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">✦</span>
            <div className="ai-bubble ai-busy">
              <div className="ai-busy-head">
                <Spinner size="md" />
                <span className="ai-busy-status">{status || 'Thinking…'}</span>
              </div>
              {reasoning && (
                <details className="ai-thinking" open={busy}>
                  <summary>Thinking</summary>
                  <div className="ai-thinking-body" ref={thinkingRef}>{reasoning}</div>
                </details>
              )}
              {tools.length > 0 && (
                <div className="ai-tool-feed">
                  {tools.map((t) => (
                    <div
                      className={`ai-tool-row${t.ok === null ? '' : t.ok ? ' ok' : ' fail'}`}
                      key={t.callId}
                    >
                      <span className="ai-tool-name">
                        <span className="ai-tool-state" aria-hidden="true">
                          {t.ok === null ? <Spinner size="sm" shade="subtle" /> : t.ok ? '✓' : '✗'}
                        </span>
                        {t.display}
                      </span>
                      {t.args && <code className="ai-tool-args">{t.args}</code>}
                      {t.ok !== null && t.summary && (
                        <span className="ai-tool-summary" title={t.summary}>{t.summary}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {writing && <div className="ai-busy-writing">Writing answer…</div>}
            </div>
          </div>
        )}
      </section>

      <footer className="ai-composer-wrap">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={(v) => send(v)}
          isDisabled={busy}
          placeholder='Ask about liquidity, volatility, or a ticker…'
          sendButton={
            getApiKey() ? (
              <ChatSendButton />
            ) : (
              <Button variant="primary" label="Connect" tooltip="Connect to start chatting" onClick={() => setShowSettings(true)} />
            )
          }
        />
      </footer>
    </section>
  );
}

export default AiChat;