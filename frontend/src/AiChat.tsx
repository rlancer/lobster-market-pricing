import { useCallback, useEffect, useRef, useState } from 'react';
import './AiChat.css';
import { type QueryResult } from './api';
import {
  askAi,
  clearApiKey,
  getApiKey,
  getModel,
  handleOAuthCallback,
  isOAuthCallback,
  setApiKey,
  setModel,
  startOAuthFlow,
} from './ai';

const MODEL_SUGGESTIONS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.1-8b-instruct',
  'openrouter/auto',
];

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

function AiChat() {
  const [key, setKeyState] = useState(getApiKey());
  const [model, setModelState] = useState(getModel());
  const [showSettings, setShowSettings] = useState(!getApiKey());
  const [oauthBusy, setOauthBusy] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy, status]);

  const saveKey = () => {
    setApiKey(key);
    setShowSettings(false);
    setError(null);
  };
  const saveModel = (m: string) => {
    setModel(m);
    setModelState(m);
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
    setMsgs((m) => [...m, { id: uid(), role: 'user', content: question }]);
    setBusy(true);
    setStatus('Starting…');
    try {
      const res = await askAi(question, { onStatus: setStatus });
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: res.answer, sql: res.sql, result: res.result },
      ]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: uid(), role: 'assistant', content: '', error: String(e) },
      ]);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }, [busy]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const newChat = () => {
    setMsgs([]);
    setError(null);
  };

  const openExplorerSql = (sql: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'explorer');
    window.history.pushState(null, '', `${window.location.pathname}?${params.toString()}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    // Pass the SQL to the explorer via a custom event; Explorer picks it up.
    window.dispatchEvent(new CustomEvent('ai:load-sql', { detail: { sql } }));
  };

  return (
    <div className="ai-chat">
      <div className="ai-head">
        <div className="ai-title">
          <span className="ai-mark" aria-hidden="true">✦</span>
          <div>
            <h2>Options Copilot</h2>
            <p>Ask in plain English — SQL runs locally on your dataset.</p>
          </div>
        </div>
        <div className="ai-head-actions">
          <span className={`ai-key-dot ${getApiKey() ? 'ok' : ''}`} title={getApiKey() ? 'API key set' : 'No API key'} />
          <button className="ai-ghost" onClick={() => setShowSettings((s) => !s)}>Settings</button>
          <button className="ai-ghost" onClick={newChat}>New chat</button>
        </div>
      </div>

      {showSettings && (
        <div className="ai-settings">
          <div className="ai-settings-connect">
            <span className="ai-settings-label">Connect your OpenRouter account</span>
            <button className="ai-connect-btn" onClick={connect} disabled={oauthBusy}>
              {oauthBusy ? 'Connecting…' : 'Connect with OpenRouter ↗'}
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
            <label>
              <span>Model</span>
              <input
                list="ai-model-list"
                value={model}
                spellCheck={false}
                placeholder="openai/gpt-4o-mini"
                onChange={(e) => saveModel(e.target.value)}
              />
              <datalist id="ai-model-list">
                {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
              </datalist>
            </label>
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
          <div className="ai-welcome">
            <p>
              I can translate your questions into DuckDB queries and run them
              against <b>option_contracts</b>, <b>underlyings</b> and <b>download_log</b>
              {' '}right in your browser.
            </p>
            <div className="ai-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => send(ex)} disabled={busy}>{ex}</button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m) => (
          <div key={m.id} className={`ai-msg ai-${m.role}`}>
            {m.role === 'assistant' && (
              <span className="ai-msg-mark" aria-hidden="true">✦</span>
            )}
            <div className="ai-bubble">
              {m.error ? (
                <div className="ai-err">{m.error}</div>
              ) : (
                <>
                  {m.content && <div className="ai-text">{m.content}</div>}
                  {m.sql && (
                    <div className="ai-sql">
                      <div className="ai-sql-head">
                        <span>SQL</span>
                        <button
                          onClick={() => openExplorerSql(m.sql!)}
                          title="Open in SQL Lab"
                        >
                          Open in SQL Lab ↗
                        </button>
                      </div>
                      <pre>{m.sql}</pre>
                    </div>
                  )}
                  {m.result && <ResultTable result={m.result} />}
                </>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">✦</span>
            <div className="ai-bubble ai-busy">
              <span className="ai-spinner" aria-hidden="true" />
              {status || 'Thinking…'}
            </div>
          </div>
        )}
      </div>

      <div className="ai-composer">
        <textarea
          ref={inputRef}
          value={input}
          placeholder='Ask something like "find ATM puts with high IV in the Tech sector"'
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={busy}
        />
        <button className="ai-send" onClick={() => send(input)} disabled={busy || !input.trim()}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
      <div className="ai-foot">Enter to send · Shift+Enter for newline · Bring-your-own-key · SQL never leaves your browser</div>
    </div>
  );
}

export default AiChat;