import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import './AiChat.css';
import {
  Button,
  ChatComposer,
  ChatMessageMetadata,
  ChatSendButton,
  Dialog,
  DialogHeader,
  IconButton,
  Markdown,
  Selector,
  Spinner,
  Timestamp,
  Tooltip,
  useChatStreamScroll,
} from '@astryxdesign/core';
import { Settings, Share2, SquarePen } from 'lucide-react';
import { api, type ChatHistoryMessage, type ChatHistoryRecord, type FreeQuota, type QueryResult, type ShareChatResponse } from './api';
import { CopyButton } from './CopyButton';
import { OpenRouterLogo } from './OpenRouterLogo';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { ChartView, type ChartSpec } from './Chart';
import {
  askAi,
  clearApiKey,
  createSession,
  FALLBACK_MODEL_GROUPS,
  fetchAvailableModels,
  FREE_MODEL,
  FreeCreditExhausted,
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
  // Share-chat state: POST the transcript → D1 (shared_chats); the dialog
  // shows the copyable link + a "View" action onto the public share page.
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareResult, setShareResult] = useState<ShareChatResponse | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  // Free anonymous chats (no browser key): the site's OpenRouter credit
  // balance (chip) + whether the credit is out (composer pivots to BYOK).
  const [quota, setQuota] = useState<FreeQuota | null>(null);
  const [freeExhausted, setFreeExhausted] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  // Chat-history capture state (server-side lake record via /api/chat/history).
  // chatId is per conversation (stable across turns — one lake row per turn
  // carries the full conversation so far, so an admin can dedupe by chat_id);
  // startedAt pins the conversation start; msgsRef always mirrors the latest
  // msgs (the send closure is stale); userMsgRef tracks this turn's user
  // message so the transcript is built without duplicates.
  const chatIdRef = useRef<string>(crypto.randomUUID());
  const startedAtRef = useRef<number | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const userMsgRef = useRef<Msg | null>(null);
  useEffect(() => {
    msgsRef.current = msgs;
  }, [msgs]);

  // Fire-and-forget save of the completed turn to the lake: previous turns +
  // this turn's user + assistant messages, trimmed to {role, content, sql, ts}
  // (bulky query-result tables and chart specs stay in the session, not the
  // lake). Best-effort — failures are swallowed; a chat is never blocked by
  // history persistence.
  const saveTranscript = useCallback((assistant: Msg) => {
    const chatId = chatIdRef.current;
    if (!chatId) return;
    const user = userMsgRef.current;
    const prior = msgsRef.current.filter((m) => m !== user && m.id !== assistant.id);
    const turns: ChatHistoryMessage[] = [...prior, ...(user ? [user] : []), assistant]
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.sql ? { sql: m.sql } : {}),
        ...(m.ts ? { ts: m.ts } : {}),
      }))
      .slice(-100); // bounds the POST body; the Worker enforces the same cap
    const record: ChatHistoryRecord = {
      chat_id: chatId,
      mode: getApiKey() ? 'byok' : 'free',
      model: getApiKey() ? getModel() : FREE_MODEL,
      started_at: new Date(startedAtRef.current ?? Date.now()).toISOString(),
      ended_at: new Date().toISOString(),
      messages: turns,
    };
    api.saveChatHistory(record).catch(() => {
      /* best-effort */
    });
  }, []);

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

  // Free-tier credit balance. Fetched on mount (and whenever a key appears /
  // disappears): a key present means BYOK, so the chip + exhausted gate clear.
  // After each free chat the balance is re-read (send()'s finally) so the chip
  // tracks spend. A failed fetch leaves the gate open — a live 402 still
  // pivots it.
  const refreshFreeQuota = useCallback(() => {
    if (getApiKey()) {
      setQuota(null);
      setFreeExhausted(false);
      return;
    }
    api.freeQuota().then(setQuota).catch(() => setQuota(null));
  }, []);

  useEffect(() => {
    refreshFreeQuota();
  }, [key, refreshFreeQuota]);

  // Free credit exhausted: quota reports 0 / unfunded key, or the free proxy
  // returned 402 mid-chat (FreeCreditExhausted). When gated, the composer
  // submits to the BYOK connect flow instead of chatting.
  const quotaExhausted = quota !== null && (quota.remaining <= 0 || quota.is_free_tier);
  const freeGated = !getApiKey() && (freeExhausted || quotaExhausted);
  // Share becomes available once the conversation has ≥1 completed turn.
  const canShare = msgs.some((m) => m.role === 'assistant');

  // POST the current transcript to D1 (shared_chats) and reveal the public
  // link. Reuses the exact transcript shape saveTranscript sends to the lake
  // (same trimmer, same record fields) so a share is a projection of the
  // conversation. User-requested → errors surface in the dialog, not silently.
  const shareChat = async () => {
    setShareBusy(true);
    setShareError(null);
    try {
      const turns: ChatHistoryMessage[] = msgs
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.sql ? { sql: m.sql } : {}),
          ...(m.ts ? { ts: m.ts } : {}),
        }))
        .slice(-100); // bounds the POST body; the Worker enforces the same cap
      const record: ChatHistoryRecord = {
        chat_id: chatIdRef.current,
        mode: getApiKey() ? 'byok' : 'free',
        model: getApiKey() ? getModel() : FREE_MODEL,
        started_at: new Date(startedAtRef.current ?? Date.now()).toISOString(),
        ended_at: new Date().toISOString(),
        messages: turns,
      };
      const res = await api.shareChat(record);
      setShareResult(res);
      setShareOpen(true);
    } catch (e) {
      setShareError(String((e as Error)?.message ?? e));
      setShareOpen(true);
    } finally {
      setShareBusy(false);
    }
  };

  const closeShareDialog = () => {
    setShareOpen(false);
    setShareResult(null);
    setShareError(null);
  };

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
    setKeyState(key);
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
    // No key → free chat on the site's OpenRouter credit (Worker /api/free/v1).
    // A key present → BYOK, byte-identical to before.
    setInput('');
    setError(null);
    // Fresh progress panel per question.
    setReasoning('');
    setWriting(false);
    setTools([]);
    const now = Date.now();
    if (startedAtRef.current === null) startedAtRef.current = now;
    const userMsg: Msg = { id: uid(), role: 'user', content: question, ts: now };
    userMsgRef.current = userMsg;
    setMsgs((m) => [...m, userMsg]);
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
      const assistantMsg: Msg = { id: uid(), role: 'assistant', content: res.answer, sql: res.sql, result: res.result, chart: res.chart, ts: Date.now(), model: getApiKey() ? getModel() : FREE_MODEL };
      setMsgs((m) => [...m, assistantMsg]);
      saveTranscript(assistantMsg);
      syncFrames();
    } catch (e) {
      // Free credit ran out mid-chat: pivot to the BYOK connect gate (CTA in
      // the composer + welcome panel) instead of dumping an error bubble.
      if (e instanceof FreeCreditExhausted) {
        setFreeExhausted(true);
        setStatus('Free credit exhausted');
        return;
      }
      const errorMsg: Msg = { id: uid(), role: 'assistant', content: '', error: String(e), ts: Date.now() };
      setMsgs((m) => [...m, errorMsg]);
      saveTranscript(errorMsg);
    } finally {
      setBusy(false);
      setStatus('');
      // Re-read the balance after a free chat so the chip tracks spend.
      if (!getApiKey()) refreshFreeQuota();
    }
  }, [busy, session, syncFrames, refreshFreeQuota]);

  const newChat = () => {
    session.frames.clear();
    session.history.length = 0;
    setFrames([]);
    setMsgs([]);
    setError(null);
    chatIdRef.current = crypto.randomUUID();
    startedAtRef.current = null;
    userMsgRef.current = null;
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
          {getApiKey() && (
            <Tooltip content="OpenRouter connected" hasHoverIndication={false}>
              <span className="ai-key-dot ok" />
            </Tooltip>
          )}
          {getApiKey() && (
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
          )}
          <IconButton variant="ghost" size="sm" label="Settings" icon={<Settings size={16} />} tooltip="Settings" onClick={() => setShowSettings((s) => !s)} />
          <IconButton
            variant="ghost"
            size="sm"
            label="Share chat"
            icon={<Share2 size={16} />}
            tooltip={canShare ? 'Share chat' : 'Share available after the first answer'}
            isDisabled={!canShare || busy}
            isLoading={shareBusy}
            onClick={shareChat}
          />
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
          <p className="ai-free-note">
            {!getApiKey() && (
              <>Free chats are paid for by this site's OpenRouter credit — no account needed. </>
            )}
            Chat transcripts are stored anonymously (no name, no login) and are only visible to the
            site owner.
            {!getApiKey() && quota && quota.remaining > 0 && !quota.is_free_tier && (
              <> Free credit: ${quota.remaining.toFixed(2)} left.</>
            )}
          </p>
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
              isDisabled={!getApiKey()}
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
              <p className="ai-welcome-data">
                Live options chains for US equities and the major ETFs — calls &amp; puts, strikes,
                implied vol, open interest, volume, greeks — plus spot quotes, IV rank,
                realized vol, earnings, corporate actions, news, web search, and the macro calendar.
              </p>
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
              <section className="ai-welcome-connect" aria-label="Chat access">
                {freeGated ? (
                  <>
                    <p><b>Free credit's out</b> — Connect OpenRouter to keep chatting.</p>
                    <button className="ai-connect-btn" onClick={connect} disabled={oauthBusy}>
                      {oauthBusy ? 'Connecting…' : 'Connect OpenRouter'}
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      <b>Currently using {FREE_MODEL.replace('~', '')}</b> — free.
                      Connect OpenRouter to use any model.
                    </p>
                    <button className="ai-ghost ai-connect-btn" onClick={connect} disabled={oauthBusy}>
                      {oauthBusy ? 'Connecting…' : 'Use your own key'}
                    </button>
                  </>
                )}
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
            getApiKey() || !freeGated ? (
              <ChatSendButton />
            ) : (
              <Button
                variant="primary"
                label="Connect"
                aria-label="Free credit's out — connect OpenRouter to keep chatting"
                tooltip="Free credit's out — connect OpenRouter to keep chatting"
                onClick={() => setShowSettings(true)}
              />
            )
          }
        />
      </footer>

      <Dialog isOpen={shareOpen} onOpenChange={(o) => !o && closeShareDialog()} width={460}>
        <DialogHeader
          title={shareError ? 'Share failed' : shareResult ? 'Chat shared' : 'Share chat'}
          subtitle={
            shareResult
              ? 'Anyone with this link can view the transcript — no account needed.'
              : undefined
          }
          onOpenChange={() => closeShareDialog()}
        />
        {shareBusy && (
          <div className="ai-share-body ai-share-busy">
            <Spinner size="md" />
            <span>Creating share…</span>
          </div>
        )}
        {!shareBusy && shareError && (
          <div className="ai-share-body ai-share-error">{shareError}</div>
        )}
        {!shareBusy && shareResult && (
          <>
            <div className="ai-share-body">
              <label className="ai-share-label" htmlFor="ai-share-url">Share URL</label>
              <div className="ai-share-row">
                <input
                  id="ai-share-url"
                  className="ai-share-url"
                  value={new URL(shareResult.url, window.location.href).toString()}
                  readOnly
                  onFocus={(e) => e.currentTarget.select()}
                />
                <CopyButton text={new URL(shareResult.url, window.location.href).toString()} tooltip="Copy link" />
              </div>
            </div>
            <div className="ai-share-actions">
              <Button variant="secondary" label="Done" onClick={() => closeShareDialog()} />
              <Button
                variant="primary"
                label="View share"
                onClick={() => {
                  const shareId = shareResult.share_id;
                  closeShareDialog();
                  // The public, read-only page — exactly what a recipient sees.
                  navigate({ to: '/share/$shareId', params: { shareId } });
                }}
              />
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}

export default AiChat;