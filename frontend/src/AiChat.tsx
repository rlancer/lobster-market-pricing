import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentChat, getToolCallId, getToolInput, getToolOutput, getToolPartState } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
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
  Spinner,
  Timestamp,
  Tooltip,
  useChatStreamScroll,
} from '@astryxdesign/core';
import { Share2, SquarePen } from 'lucide-react';
import { API_BASE, api, type ChatHistoryMessage, type ChatHistoryRecord, type QueryResult, type ShareChatResponse } from './api';
import { CopyButton } from './CopyButton';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { ChartView, type ChartSpec } from './Chart';

const EXAMPLES = [
  'Find the most liquid calls expiring within 30 days',
  'Which sectors have the richest put premiums?',
  'Chart the IV smile for NVDA',
  'What underlyings have the most open interest?',
];
const ACTIVE_CHAT_KEY = 'openinterest_copilot_chat_id';
const CAPTURED_IDS_PREFIX = 'openinterest_copilot_captured_';
const MAX_RENDER_ROWS = 200;

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

interface FrameMetadata {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
}

interface Presentation {
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
  model: string;
  frames: FrameMetadata[];
}

interface CopilotMetadata {
  model: string;
  createdAt: number;
}

type CopilotData = Record<string, unknown> & {
  status: { status: string };
};

type CopilotMessage = UIMessage<CopilotMetadata, CopilotData>;

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  error?: string;
  ts?: number;
  model?: string;
}

interface ToolOutput {
  ok?: boolean;
  error?: string | null;
  summary?: string;
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
  frames?: FrameMetadata[];
}

interface ToolRow {
  callId: string;
  name: string;
  display: string;
  args: string;
  ok: boolean | null;
  summary: string;
}

function fmtCell(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.error) return <div className="ai-err">Query error: {result.error}</div>;
  if (!result.columns.length) return <div className="ai-empty">Query returned no columns.</div>;
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
              {result.columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <tr key={index}>
                <td className="ai-idx">{index + 1}</td>
                {result.columns.map((column) => <td key={column}>{fmtCell(row[column])}</td>)}
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

function presentationFromMessage(message: CopilotMessage): Presentation | null {
  const model = message.metadata?.model ?? '';
  let presentation: Presentation | null = null;
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    const output = getToolOutput(part);
    if (!output || typeof output !== 'object') continue;
    const candidate = output as ToolOutput;
    if (!candidate.sql && !candidate.result && !candidate.chart && !candidate.frames) continue;
    presentation = {
      sql: candidate.sql ?? null,
      result: candidate.result ?? null,
      chart: candidate.chart ?? null,
      model,
      frames: candidate.frames ?? [],
    };
  }
  return presentation;
}

function projectMessage(message: CopilotMessage): Msg | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
  const presentation = presentationFromMessage(message);
  return {
    id: message.id,
    role: message.role,
    content,
    ...(presentation ? {
      sql: presentation.sql,
      result: presentation.result,
      chart: presentation.chart,
      model: presentation.model,
    } : {}),
    ...(message.metadata?.createdAt ? { ts: message.metadata.createdAt } : {}),
    ...(!presentation && message.metadata?.model ? { model: message.metadata.model } : {}),
  };
}

function projectTools(message: CopilotMessage | undefined): ToolRow[] {
  if (!message) return [];
  return message.parts.flatMap((part): ToolRow[] => {
    if (!isToolUIPart(part)) return [];
    const name = getToolName(part);
    const state = getToolPartState(part);
    const input = getToolInput(part);
    const rawOutput = getToolOutput(part);
    const output = rawOutput && typeof rawOutput === 'object' ? rawOutput as ToolOutput : undefined;
    const complete = state === 'complete' || state === 'error' || state === 'denied';
    return [{
      callId: getToolCallId(part),
      name,
      display: TOOL_LABELS[name] ?? name.replaceAll('_', ' '),
      args: input === undefined ? '' : JSON.stringify(input),
      ok: complete ? state === 'complete' && output?.ok !== false : null,
      summary: output?.summary ?? output?.error ?? '',
    }];
  });
}

function AiChatSession({ chatId, onNewChat }: { chatId: string; onNewChat: () => void }) {
  const [input, setInput] = useState('');
  const [progressStatus, setProgressStatus] = useState('');
  const [frames, setFrames] = useState<FrameMetadata[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareResult, setShareResult] = useState<ShareChatResponse | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const host = API_BASE ? new URL(API_BASE).host : window.location.host;
  const agent = useAgent({
    agent: 'CopilotAgent',
    name: chatId,
    host,
  });
  const {
    messages,
    sendMessage,
    status: chatStatus,
    error: chatError,
    isStreaming,
    isRecovering,
    isToolContinuation,
    connectionError,
  } = useAgentChat<unknown, CopilotMessage>({
    agent,
    resume: true,
    cancelOnClientAbort: false,
    body: () => ({ origin: window.location.origin }),
    onData: (part) => {
      if (part.type === 'data-status' && typeof part.data === 'object' && part.data !== null && 'status' in part.data && typeof part.data.status === 'string') {
        setProgressStatus(part.data.status);
      }
    },
  });

  const busy = chatStatus === 'submitted' || chatStatus === 'streaming' || isStreaming || isRecovering || isToolContinuation;
  const projectedMessages = useMemo(() => messages.map(projectMessage).filter((message): message is Msg => message !== null), [messages]);
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const reasoning = latestAssistant?.parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('') ?? '';
  const tools = projectTools(latestAssistant);
  const writing = Boolean(latestAssistant?.parts.some((part) => part.type === 'text' && part.text));
  const visibleError = chatError?.message ?? connectionError?.message;
  const status = isRecovering
    ? 'Recovering interrupted answer…'
    : progressStatus || (chatStatus === 'submitted' ? 'Starting…' : 'Thinking…');
  const latestPresentation = latestAssistant ? presentationFromMessage(latestAssistant) : null;
  const latestFrameSignature = JSON.stringify(latestPresentation?.frames ?? []);

  useEffect(() => {
    if (latestPresentation) setFrames(latestPresentation.frames);
  }, [latestFrameSignature]);

  useEffect(() => {
    let active = true;
    void agent.ready
      .then(() => agent.call<FrameMetadata[]>('getFrameMetadata', []))
      .then((metadata) => {
        if (active) setFrames(metadata);
      })
      .catch(() => {
        // Frame chips are supplementary; persisted message output is the fallback.
      });
    return () => { active = false; };
  }, [chatId]);

  const capturedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    try {
      const ids = JSON.parse(sessionStorage.getItem(CAPTURED_IDS_PREFIX + chatId) ?? '[]') as unknown;
      if (Array.isArray(ids)) capturedIdsRef.current = new Set(ids.filter((id): id is string => typeof id === 'string'));
    } catch {
      capturedIdsRef.current = new Set();
    }
  }, [chatId]);

  useEffect(() => {
    if (busy) return;
    for (let index = 0; index < projectedMessages.length; index++) {
      const assistant = projectedMessages[index];
      if (assistant.role !== 'assistant' || !assistant.content || capturedIdsRef.current.has(assistant.id)) continue;
      const turns: ChatHistoryMessage[] = projectedMessages.slice(0, index + 1).map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.sql ? { sql: message.sql } : {}),
        ...(message.ts ? { ts: message.ts } : {}),
      })).slice(-100);
      const record: ChatHistoryRecord = {
        chat_id: chatId,
        mode: 'funded',
        model: assistant.model,
        started_at: new Date(startedAtRef.current ?? assistant.ts ?? Date.now()).toISOString(),
        ended_at: new Date(assistant.ts ?? Date.now()).toISOString(),
        messages: turns,
      };
      capturedIdsRef.current.add(assistant.id);
      sessionStorage.setItem(CAPTURED_IDS_PREFIX + chatId, JSON.stringify([...capturedIdsRef.current].slice(-100)));
      api.saveChatHistory(record).catch(() => {
        // Best-effort abuse-context-preserving history capture.
      });
    }
  }, [busy, chatId, projectedMessages]);

  const { scrollIfLocked } = useChatStreamScroll({ scrollRef });
  useEffect(() => {
    scrollIfLocked();
  }, [scrollIfLocked, projectedMessages, busy, status, reasoning]);

  useEffect(() => {
    const element = thinkingRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [reasoning]);

  const send = useCallback((raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    setInput('');
    setProgressStatus('Starting…');
    sendMessage({ text: question });
  }, [busy, sendMessage]);

  const canShare = projectedMessages.some((message) => message.role === 'assistant' && message.content);
  const shareChat = async () => {
    setShareBusy(true);
    setShareError(null);
    try {
      const turns: ChatHistoryMessage[] = projectedMessages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.sql ? { sql: message.sql } : {}),
        ...(message.ts ? { ts: message.ts } : {}),
      })).slice(-100);
      const latestModel = [...projectedMessages].reverse().find((message) => message.model)?.model;
      const response = await api.shareChat({
        chat_id: chatId,
        mode: 'funded',
        model: latestModel,
        started_at: new Date(startedAtRef.current ?? Date.now()).toISOString(),
        ended_at: new Date().toISOString(),
        messages: turns,
      });
      setShareResult(response);
      setShareOpen(true);
    } catch (error) {
      setShareError(String((error as Error)?.message ?? error));
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

  return (
    <section className="ai-chat">
      <header className="ai-head" aria-label="Chat controls">
        <section className="ai-head-actions">
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
          <IconButton variant="ghost" size="sm" label="New chat" icon={<SquarePen size={16} />} tooltip="New chat" onClick={onNewChat} />
        </section>
      </header>

      {frames.length > 0 && (
        <div className="ai-frames">
          <span className="ai-frames-label">Session data</span>
          {frames.map((frame) => {
            const ageMin = Math.round((Date.now() - frame.fetched_at) / 60000);
            return (
              <Tooltip key={frame.name} content={`${frame.row_count.toLocaleString()} rows · ${frame.columns.length} cols · ${frame.sql}`} hasHoverIndication={false}>
                <span className="ai-frame-chip">
                  <b>{frame.name}</b>
                  <span className="ai-frame-meta">{frame.row_count.toLocaleString()}r · {ageMin < 1 ? 'fresh' : `${ageMin}m`}</span>
                </span>
              </Tooltip>
            );
          })}
        </div>
      )}

      <section className="ai-messages" ref={scrollRef}>
        {projectedMessages.length === 0 && (
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
              {EXAMPLES.map((example) => (
                <button key={example} className="ai-example-card" onClick={() => send(example)} disabled={busy}>
                  <span>{example}</span>
                  <span className="ai-example-arrow" aria-hidden="true">↗</span>
                </button>
              ))}
            </nav>
          </section>
        )}

        {projectedMessages.map((message) => (
          <div key={message.id} className={`ai-msg ai-${message.role}`}>
            {message.role === 'assistant' && <span className="ai-msg-mark" aria-hidden="true">λ</span>}
            <div className="ai-bubble">
              {message.content && (
                message.role === 'assistant'
                  ? <div className="ai-text"><Markdown>{message.content}</Markdown></div>
                  : <div className="ai-text">{message.content}</div>
              )}
              {message.sql && (
                <div className="ai-sql">
                  <div className="ai-sql-head">
                    <span>SQL</span>
                    <span className="ai-sql-actions">
                      <CopyButton text={message.sql} />
                      <Tooltip content="Open in SQL Lab" hasHoverIndication={false}>
                        <button onClick={() => navigate({ to: '/lab', search: { sql: message.sql! } })}>Open in SQL Lab ↗</button>
                      </Tooltip>
                    </span>
                  </div>
                  <pre>{message.sql}</pre>
                </div>
              )}
              {message.result && <ResultTable result={message.result} />}
              {message.chart && message.result && <ChartView result={message.result} spec={message.chart} />}
              {message.role === 'assistant' && (message.ts !== undefined || message.model) && (
                <ChatMessageMetadata
                  timestamp={message.ts !== undefined ? <Timestamp value={message.ts / 1000} format="time" /> : undefined}
                  footer={message.model}
                />
              )}
            </div>
          </div>
        ))}

        {visibleError && !busy && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">λ</span>
            <div className="ai-bubble"><div className="ai-err">{visibleError}</div></div>
          </div>
        )}

        {busy && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">✦</span>
            <div className="ai-bubble ai-busy">
              <div className="ai-busy-head"><Spinner size="md" /><span className="ai-busy-status">{status}</span></div>
              {reasoning && (
                <details className="ai-thinking" open={busy}>
                  <summary>Thinking</summary>
                  <div className="ai-thinking-body" ref={thinkingRef}>{reasoning}</div>
                </details>
              )}
              {tools.length > 0 && (
                <div className="ai-tool-feed">
                  {tools.map((toolRow) => (
                    <div className={`ai-tool-row${toolRow.ok === null ? '' : toolRow.ok ? ' ok' : ' fail'}`} key={toolRow.callId}>
                      <span className="ai-tool-name">
                        <span className="ai-tool-state" aria-hidden="true">{toolRow.ok === null ? <Spinner size="sm" shade="subtle" /> : toolRow.ok ? '✓' : '✗'}</span>
                        {toolRow.display}
                      </span>
                      {toolRow.args && <code className="ai-tool-args">{toolRow.args}</code>}
                      {toolRow.ok !== null && toolRow.summary && <span className="ai-tool-summary" title={toolRow.summary}>{toolRow.summary}</span>}
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
          onSubmit={send}
          isDisabled={busy}
          placeholder="Ask about liquidity, volatility, or a ticker…"
          sendButton={<ChatSendButton />}
        />
      </footer>

      <Dialog isOpen={shareOpen} onOpenChange={(open) => !open && closeShareDialog()} width={460}>
        <DialogHeader
          title={shareError ? 'Share failed' : shareResult ? 'Chat shared' : 'Share chat'}
          subtitle={shareResult ? 'Anyone with this link can view the transcript — no account needed.' : undefined}
          onOpenChange={closeShareDialog}
        />
        {shareBusy && <div className="ai-share-body ai-share-busy"><Spinner size="md" /><span>Creating share…</span></div>}
        {!shareBusy && shareError && <div className="ai-share-body ai-share-error">{shareError}</div>}
        {!shareBusy && shareResult && (
          <>
            <div className="ai-share-body">
              <label className="ai-share-label" htmlFor="ai-share-url">Share URL</label>
              <div className="ai-share-row">
                <input id="ai-share-url" className="ai-share-url" value={new URL(shareResult.url, window.location.href).toString()} readOnly onFocus={(event) => event.currentTarget.select()} />
                <CopyButton text={new URL(shareResult.url, window.location.href).toString()} tooltip="Copy link" />
              </div>
            </div>
            <div className="ai-share-actions">
              <Button variant="secondary" label="Done" onClick={closeShareDialog} />
              <Button
                variant="primary"
                label="View share"
                onClick={() => {
                  const shareId = shareResult.share_id;
                  closeShareDialog();
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

function AiChat() {
  const [chatId, setChatId] = useState(() => {
    const existing = sessionStorage.getItem(ACTIVE_CHAT_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(ACTIVE_CHAT_KEY, created);
    return created;
  });
  const newChat = useCallback(() => {
    const created = crypto.randomUUID();
    sessionStorage.setItem(ACTIVE_CHAT_KEY, created);
    setChatId(created);
  }, []);
  return <AiChatSession key={chatId} chatId={chatId} onNewChat={newChat} />;
}

export default AiChat;
