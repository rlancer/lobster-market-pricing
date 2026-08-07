import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import './AiChat.css';
import {
  Button,
  ChatComposer,
  ChatMessageMetadata,
  ChatSendButton,
  Markdown,
  Selector,
  Spinner,
  Timestamp,
  useChatStreamScroll,
} from '@astryxdesign/core';
import { type QueryResult } from './api';
import { OpenRouterLogo } from './OpenRouterLogo';
import {
  askAi,
  clearApiKey,
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
  'Find the most liquid call options expiring within 30 days',
  'Which sectors have the richest put premiums (highest IV)?',
  'Show me ATM calls with delta near 0.5 and volume over 1,000',
  'What underlyings have the most open interest?',
];

const uid = () => Math.random().toString(36).slice(2);

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string | null;
  result?: QueryResult | null;
  error?: string;
  /** Epoch ms when the message was produced. */
  ts?: number;
  /** Model that answered (assistant only). */
  model?: string;
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

function ResultTable({ result }: { result: QueryResult }) {
  if (result.error) {
    return <div className="ai-err">Query error: {result.error}</div>;
  }
  if (!result.columns.length) {
    return <div className="ai-empty">Query returned no columns.</div>;
  }
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
            {result.rows.map((row, i) => (
              <tr key={i}>
                <td className="ai-idx">{i + 1}</td>
                {result.columns.map((c) => <td key={c}>{fmtCell(row[c])}</td>)}
              </tr>
            ))}
            {result.rows.length === 0 && (
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
    <button type="button" className="ai-sql-copy" onClick={copy} title="Copy SQL">
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

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
  }, [scrollIfLocked, msgs, busy, status]);

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
    const now = Date.now();
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: question, ts: now }]);
    setBusy(true);
    setStatus('Starting…');
    try {
      const res = await askAi(question, { onStatus: setStatus });
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: res.answer, sql: res.sql, result: res.result, ts: Date.now(), model: getModel() },
      ]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: '', error: String(e), ts: Date.now() },
      ]);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }, [busy]);

  const newChat = () => {
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
    <div className="ai-chat">
      <div className="ai-head">
        <div className="ai-title">
          <span className="ai-mark" aria-hidden="true">λ</span>
          <div>
            <h2>Options Copilot</h2>
            <p>Ask in plain English — SQL runs locally on your dataset.</p>
          </div>
        </div>
        <div className="ai-head-actions">
          <span className={`ai-key-dot ${getApiKey() ? 'ok' : ''}`} title={getApiKey() ? 'API key set' : 'No API key'} />
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
          <Selector
            label="Reasoning effort"
            size="sm"
            isLabelHidden
            width={120}
            isDisabled={effortDisabled}
            disabledMessage={effortDisabledMessage}
            options={EFFORT_OPTIONS}
            value={effort}
            onChange={(e) => { if (e) saveEffort(e as ReasoningEffort); }}
          />
          <Button variant="ghost" size="sm" label="Settings" onClick={() => setShowSettings((s) => !s)} />
          <Button variant="ghost" size="sm" label="New chat" onClick={newChat} />
        </div>
      </div>

      {showSettings && (
        <div className="ai-settings">
          <div className="ai-settings-connect">
            <span className="or-badge" aria-hidden="true">
              <OpenRouterLogo width={32} height={24} color="#7F3DFF" />
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
          <p className="ai-settings-note">
            Your key is sent only to <b>openrouter.ai</b> from your browser. It is never
            uploaded to this site's servers. You can grab one at
            {' '}<a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>.
          </p>
        </div>
      )}

      {error && <div className="ai-error-banner">{error}</div>}

      <div className="ai-messages" ref={scrollRef}>
        {msgs.length === 0 && (
          <section className="ai-welcome">
            <header className="ai-welcome-hero">
              <figure className="ai-welcome-mark" aria-label="Volatility smile curve">
                <svg viewBox="0 0 240 76" role="img" aria-hidden="true">
                  <path className="smile-grid" d="M8 18H232M8 38H232M8 58H232M40 8V68M80 8V68M120 8V68M160 8V68M200 8V68" />
                  <path className="smile-curve" d="M12 14C50 55 83 62 120 62C157 62 190 55 228 14" />
                  <circle cx="120" cy="62" r="4" />
                </svg>
                <figcaption>Implied volatility / strike</figcaption>
              </figure>
              <span className="ai-welcome-kicker">Natural-language market research</span>
              <h1>Interrogate the volatility surface</h1>
              <p>
                Ask a market question. Copilot writes the SQL and runs it against
                <b> option_contracts</b>, <b>underlyings</b> and <b>refresh_runs</b>.
              </p>
            </header>
            <div className="ai-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="ai-example-card" onClick={() => send(ex)} disabled={busy}>
                  <span className="ai-example-arrow" aria-hidden="true">↗</span>
                  <span>{ex}</span>
                </button>
              ))}
            </div>
            {!getApiKey() && (
              <div className="ai-welcome-connect">
                <span className="or-badge" aria-hidden="true">
                  <OpenRouterLogo width={30} height={22} color="#7F3DFF" />
                </span>
                <div className="ai-welcome-connect-text">
                  <b>Connect your model</b>
                  <span>Sign in with OpenRouter to start — your key stays in your browser.</span>
                </div>
                <button className="ai-connect-btn" onClick={connect} disabled={oauthBusy}>
                  {oauthBusy ? 'Connecting…' : 'Connect with OpenRouter'}
                </button>
              </div>
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
                          <button
                            onClick={() => openExplorerSql(m.sql!)}
                            title="Open in SQL Lab"
                          >
                            Open in SQL Lab ↗
                          </button>
                        </span>
                      </div>
                      <pre>{m.sql}</pre>
                    </div>
                  )}
                  {m.result && <ResultTable result={m.result} />}
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
              <Spinner size="md" />
              <span>{status || 'Thinking…'}</span>
            </div>
          </div>
        )}
      </div>

      <div className="ai-composer-wrap">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={(v) => send(v)}
          isDisabled={busy}
          placeholder='Try "find ATM puts with high IV in the Tech sector"…'
          sendButton={
            getApiKey() ? (
              <ChatSendButton />
            ) : (
              <Button variant="primary" label="Connect" tooltip="Connect to start chatting" onClick={() => setShowSettings(true)} />
            )
          }
        />
        <div className="ai-foot">
          Enter to send · Shift+Enter for newline · Bring your own key · SQL never leaves your browser
        </div>
      </div>
    </div>
  );
}

export default AiChat;