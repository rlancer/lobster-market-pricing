import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAgentChat, getToolCallId, getToolInput, getToolOutput, getToolPartState } from '@cloudflare/ai-chat/react';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useLocation, useNavigate } from '@tanstack/react-router';
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
  StatusDot,
  Switch,
  Timestamp,
  Tooltip,
  useChatStreamScroll,
} from '@astryxdesign/core';
import { Share2, SquarePen, Trash2 } from 'lucide-react';
import { API_BASE, api, type ChatHistoryMessage, type ChatHistoryRecord, type QueryResult, type ShareChatMessage, type ShareChatResponse } from './api';
import { authClient, signInWithGoogle } from './auth';
import { useAgentReconnect } from './chatConnection';
import { clearPendingPrompt, ensureLiveChatId, notifyChatsChanged, parseChatId, peekPendingPrompt, rememberChatId, startNewChatId } from './chatSession';
import { CopyButton } from './CopyButton';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { ChartView, type ChartSpec } from './Chart';
import { MAX_RENDER_ROWS, ResultTable } from './QueryResultView';
import { chartFitsResult, inferChartSpec, wantsChart } from './chartSpec';
import { ChatContextStrip, type FrameMetadata } from './ChatContextStrip';

const EXAMPLES = [
  'Find the most liquid calls expiring within 30 days',
  'Which sectors have the richest put premiums?',
  'Chart the IV smile for NVDA',
  'What underlyings have the most open interest?',
];
const CAPTURED_IDS_PREFIX = 'openinterest_copilot_captured_';
/** Must match worker/src/copilot-scope.ts SCOPE_REJECTED_ERROR. */
const SCOPE_REJECTED_ERROR = 'No data to answer.';

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
  research_ticker: 'Ticker research',
};

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
  /** Restored from D1 history/share when the preview Durable Object is empty. */
  sql?: string | null;
  result?: QueryResult | null;
  chart?: ChartSpec | null;
}

type CopilotData = Record<string, unknown> & {
  status: { status: string };
  scope: { locked: boolean };
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
  reasoning?: string;
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

function presentationFromMessage(message: CopilotMessage): Presentation | null {
  const model = message.metadata?.model ?? '';
  let sql: string | null = null;
  let result: QueryResult | null = null;
  let chart: ChartSpec | null = null;
  let frames: FrameMetadata[] = [];
  let found = false;
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    const output = getToolOutput(part);
    if (!output || typeof output !== 'object') continue;
    const candidate = output as ToolOutput;
    if (candidate.sql) sql = candidate.sql;
    if (candidate.result) {
      result = candidate.result;
      if (chart && result.columns && !chartFitsResult(chart, result.columns)) chart = null;
    }
    if (candidate.chart) chart = candidate.chart;
    if (candidate.frames?.length) frames = candidate.frames;
    if (candidate.sql || candidate.result || candidate.chart || candidate.frames) found = true;
  }
  if (!found) return null;
  if (chart && result?.columns && !chartFitsResult(chart, result.columns)) chart = null;
  return { sql, result, chart, model, frames };
}

function withChartFallback(message: Msg, question: string): Msg {
  if (message.role !== 'assistant' || message.chart || !message.result || message.result.error) return message;
  if (!wantsChart(question)) return message;
  const inferred = inferChartSpec(message.result.columns, message.result.rows);
  return inferred ? { ...message, chart: inferred } : message;
}

/** Compact human-readable summary of a tool's input, instead of raw JSON. */
function formatToolArgs(name: string, input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'object') return String(input).slice(0, 120);
  const o = input as Record<string, unknown>;
  const squeeze = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  switch (name) {
    case 'run_query':
    case 'check_schema':
      return squeeze(o.sql).slice(0, 140);
    case 'filter_frame': {
      const bits: string[] = [String(o.frame ?? '') ?? ''];
      if (o.where) bits.push(`where ${squeeze(o.where)}`);
      if (o.sort) bits.push(`sort ${squeeze(o.sort)}`);
      if (o.limit != null) bits.push(`limit ${String(o.limit)}`);
      if (o.project) bits.push(`${Array.isArray(o.project) ? o.project.length : 1} cols`);
      return bits.filter(Boolean).join(' · ').slice(0, 140);
    }
    case 'refresh_frame':
      return String(o.frame ?? '').slice(0, 80);
    case 'render_chart':
      return `${String(o.kind ?? 'line')} · ${String(o.x ?? '?')} × ${String(o.y ?? '?')}${o.series ? ` by ${String(o.series)}` : ''}`;
    case 'get_news':
      return String(o.symbol ?? '').toUpperCase();
    case 'research_ticker':
      return String(o.symbol ?? '').toUpperCase();
    case 'web_search':
      return squeeze(o.query).slice(0, 120);
    case 'eco_calendar':
      return o.days != null ? `next ${o.days} days` : '';
    case 'list_frames':
      return '';
    default:
      return JSON.stringify(input).slice(0, 140);
  }
}

function projectMessage(message: CopilotMessage): Msg | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const content = message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('');
  const reasoning = message.parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('');
  const presentation = presentationFromMessage(message);
  const meta = message.metadata;
  return {
    id: message.id,
    role: message.role,
    content,
    ...(reasoning ? { reasoning } : {}),
    sql: presentation?.sql ?? meta?.sql ?? null,
    result: presentation?.result ?? meta?.result ?? null,
    chart: presentation?.chart ?? meta?.chart ?? null,
    ...(presentation?.model || meta?.model ? { model: presentation?.model || meta?.model } : {}),
    ...(meta?.createdAt ? { ts: meta.createdAt } : {}),
  };
}

function backupToCopilotMessages(rows: ShareChatMessage[]): CopilotMessage[] {
  return rows.map((row, index) => ({
    id: `backup-${index}-${row.ts ?? index}`,
    role: row.role,
    parts: [
      ...(row.reasoning ? [{ type: 'reasoning' as const, text: row.reasoning }] : []),
      { type: 'text' as const, text: row.content },
    ],
    metadata: {
      model: '',
      createdAt: row.ts ?? Date.now(),
      ...(row.sql ? { sql: row.sql } : {}),
      ...(row.result ? { result: row.result } : {}),
      ...(row.chart ? { chart: row.chart as ChartSpec } : {}),
    },
  }));
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
      args: formatToolArgs(name, input),
      ok: complete ? state === 'complete' && output?.ok !== false : null,
      summary: output?.summary ?? output?.error ?? '',
    }];
  });
}

function ChatDeleteControl({
  chatId,
  onNewChat,
}: {
  chatId: string;
  onNewChat: () => void;
}) {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user ?? null;
  if (isPending || !user) return null;
  return (
    <IconButton
      variant="ghost"
      size="sm"
      label="Remove from saved chats"
      icon={<Trash2 size={16} />}
      tooltip="Remove from saved chats"
      onClick={() => {
        void api.deleteChat(chatId).then(() => {
          notifyChatsChanged();
          onNewChat();
        }).catch(() => { /* keep the chat so the user can retry */ });
      }}
    />
  );
}

function TurnProgress({
  status,
  reasoning,
  tools,
  writing,
  action,
  onAction,
  thinkingRef,
}: {
  status: string;
  reasoning: string;
  tools: ToolRow[];
  writing: boolean;
  action: 'stop' | 'start';
  onAction: () => void;
  thinkingRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="ai-busy">
      <div className="ai-busy-head">{action === 'stop' && <Spinner size="md" />}<span className="ai-busy-status">{status}</span>
        <button
          className={action === 'start' ? 'ai-stop ai-start' : 'ai-stop'}
          type="button"
          onClick={onAction}
          aria-label={action === 'start' ? 'Start generating' : 'Stop generating'}
        >
          {action === 'start' ? 'Start' : 'Stop'}
        </button>
      </div>
      {reasoning && (
        <details className="ai-thinking" open>
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
  );
}

function ChatLoadingState() {
  return (
    <section className="ai-chat ai-chat-loading" aria-busy="true" aria-label="Loading chat">
      <div className="ai-chat-loading-body">
        <Spinner size="md" />
        <span>Opening chat…</span>
      </div>
    </section>
  );
}

function AiChatSession({
  chatId,
  isSavedChat,
  onNewChat,
}: {
  chatId: string;
  isSavedChat: boolean;
  onNewChat: () => void;
}) {
  const [input, setInput] = useState('');
  const [progressStatus, setProgressStatus] = useState('');
  const [scopeLocked, setScopeLocked] = useState(false);
  const [frames, setFrames] = useState<FrameMetadata[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareResult, setShareResult] = useState<ShareChatResponse | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [onTimeline, setOnTimeline] = useState(false);
  const [paused, setPaused] = useState(false);
  const [researchRefreshKey, setResearchRefreshKey] = useState(0);
  const [chatAccess, setChatAccess] = useState<'unknown' | 'ok' | 'unauthorized' | 'forbidden'>(
    isSavedChat ? 'unknown' : 'ok',
  );
  const [backupState, setBackupState] = useState<'idle' | 'loading' | 'restored' | 'missing'>('idle');
  const thinkingRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef<number | null>(null);
  const restoredIdsRef = useRef<Set<string> | null>(null);
  const claimedRef = useRef(false);
  const pausedRef = useRef(false);
  const backupAttemptedRef = useRef(false);
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const user = session?.user ?? null;
  const host = API_BASE ? new URL(API_BASE).host : window.location.host;
  const isPreviewApi = host === 'api-dev.lobster.mp' || host.startsWith('api-dev.');
  const prodChatUrl = `https://lobster.mp/chat/${chatId}`;
  const agent = useAgent({
    agent: 'CopilotAgent',
    name: chatId,
    host,
    maxRetries: Number.POSITIVE_INFINITY,
    minReconnectionDelay: 400,
    maxReconnectionDelay: 10_000,
    connectionTimeout: 8_000,
  });
  const { state: socketState, reconnect: reconnectSocket } = useAgentReconnect(agent);
  const {
    messages,
    setMessages,
    sendMessage,
    resumeStream,
    status: chatStatus,
    error: chatError,
    isStreaming,
    isRecovering,
    isToolContinuation,
    connectionError,
  } = useAgentChat<unknown, CopilotMessage>({
    agent,
    // Batch the message-store updates the agent stream pushes per part. Without
    // this, a tool-heavy turn streams many parts in quick succession and each
    // arrival re-enters the library's useSyncExternalStore `updateMessages`
    // synchronously, tripping React's "Maximum update depth exceeded" and
    // crashing the chat UI mid-turn (swallowing the final written answer).
    throttle: 80,
    resume: !paused,
    cancelOnClientAbort: false,
    // Pages (dev.lobster.mp) and the Agent (api-dev.lobster.mp) are different
    // origins. Default fetch credentials omit the session cookie, so owned
    // history 401s and the UI looks like a blank welcome chat.
    credentials: 'include',
    body: () => ({ origin: window.location.origin }),
    onData: (part) => {
      if (part.type === 'data-status' && typeof part.data === 'object' && part.data !== null && 'status' in part.data && typeof part.data.status === 'string') {
        setProgressStatus(part.data.status);
      }
      if (part.type === 'data-scope' && typeof part.data === 'object' && part.data !== null && 'locked' in part.data && part.data.locked === true) {
        setScopeLocked(true);
      }
    },
  });

  // Probe access for saved chats. Do not replace useAgentChat's getInitialMessages
  // — a custom fetcher runs before the agent HTTP URL exists and caches [].
  useEffect(() => {
    if (!isSavedChat) {
      setChatAccess('ok');
      return;
    }
    let alive = true;
    const probe = async () => {
      const raw = agent.getHttpUrl?.() ?? '';
      if (!raw) {
        // Agent URL appears once PartySocket binds; retry shortly.
        return false;
      }
      const getMessagesUrl = new URL(raw.replace(/^ws/i, 'http'));
      getMessagesUrl.pathname = getMessagesUrl.pathname.replace(/\/$/, '') + '/get-messages';
      try {
        const response = await fetch(getMessagesUrl.toString(), { credentials: 'include' });
        if (!alive) return true;
        if (response.status === 401) setChatAccess('unauthorized');
        else if (response.status === 403) setChatAccess('forbidden');
        else setChatAccess('ok');
      } catch {
        if (alive) setChatAccess('ok');
      }
      return true;
    };
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void probe().then((done) => {
        if (!alive || done) return;
        tries += 1;
        if (tries < 40) timer = setTimeout(tick, 100);
        else setChatAccess('ok');
      });
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [isSavedChat, agent, chatId, user?.id]);

  // Preview and production share D1 ownership but not CopilotAgent Durable
  // Object storage. When this environment's DO is empty for an owned chat,
  // restore from shared D1 history/share backups when available.
  useEffect(() => {
    if (!isSavedChat || !user || chatAccess !== 'ok') return;
    if (messages.length > 0) {
      setBackupState((current) => (current === 'restored' ? current : 'missing'));
      return;
    }
    if (backupAttemptedRef.current) return;
    backupAttemptedRef.current = true;
    setBackupState('loading');
    let alive = true;
    api.chatTranscript(chatId)
      .then((backup) => {
        if (!alive) return;
        if (backup.messages.length === 0) {
          setBackupState('missing');
          return;
        }
        setMessages(backupToCopilotMessages(backup.messages));
        setBackupState('restored');
      })
      .catch(() => {
        if (alive) setBackupState('missing');
      });
    return () => { alive = false; };
  }, [isSavedChat, user, chatAccess, messages.length, chatId, setMessages]);

  const busy = !paused && (chatStatus === 'submitted' || chatStatus === 'streaming' || isStreaming || isRecovering || isToolContinuation);
  const disconnected = socketState !== 'open';
  const projectedMessages = useMemo(() => {
    const projected = messages.map(projectMessage).filter((message): message is Msg => message !== null);
    return projected.map((message, index) => {
      if (message.role !== 'assistant') return message;
      const previous = projected[index - 1];
      const question = previous?.role === 'user' ? previous.content : '';
      return withChartFallback(message, question);
    });
  }, [messages]);
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  const liveAssistant = (busy || paused) && lastUserIndex >= 0
    ? messages.slice(lastUserIndex + 1).find((message) => message.role === 'assistant')
    : undefined;
  const liveAssistantId = liveAssistant?.id;
  const reasoning = liveAssistant?.parts.filter((part) => part.type === 'reasoning').map((part) => part.text).join('') ?? '';
  const tools = projectTools(liveAssistant);
  const writing = Boolean(liveAssistant?.parts.some((part) => part.type === 'text' && part.text));
  const visibleError = !busy && !paused && socketState === 'open'
    ? (scopeLocked ? SCOPE_REJECTED_ERROR : (chatError?.message ?? connectionError?.message))
    : undefined;
  const status = paused
    ? 'Paused — start to resume'
    : disconnected
      ? (socketState === 'offline' ? 'Offline — reconnecting when you are back…' : 'Reconnecting…')
      : isRecovering
        ? 'Recovering interrupted answer…'
        : progressStatus || (chatStatus === 'submitted' ? 'Starting…' : 'Thinking…');
  const latestPresentation = latestAssistant ? presentationFromMessage(latestAssistant) : null;
  const latestFrameSignature = JSON.stringify(latestPresentation?.frames ?? []);

  useEffect(() => {
    if (latestPresentation) setFrames(latestPresentation.frames);
  }, [latestFrameSignature]);

  // Refresh the chat ticker widget whenever research_ticker succeeds.
  const researchToolSig = useMemo(() => {
    const ids: string[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part)) continue;
        if (getToolName(part) !== 'research_ticker') continue;
        const state = getToolPartState(part);
        if (state === 'complete') ids.push(getToolCallId(part));
      }
    }
    return ids.join('|');
  }, [messages]);

  useEffect(() => {
    if (!researchToolSig) return;
    setResearchRefreshKey((n) => n + 1);
  }, [researchToolSig]);

  useEffect(() => {
    setScopeLocked(false);
    let active = true;
    void agent.ready
      .then(() => agent.call<{ locked: boolean }>('getScopeLock', []))
      .then((state) => {
        if (active && state?.locked) setScopeLocked(true);
      })
      .catch(() => {
        // Scope lock is best-effort until the Agent is reachable; send still fails closed server-side.
      });
    return () => { active = false; };
  }, [chatId, agent]);

  useEffect(() => {
    if (chatError?.message === SCOPE_REJECTED_ERROR) setScopeLocked(true);
  }, [chatError]);

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

  const firstUserTurn = projectedMessages.find((message) => message.role === 'user' && message.content.trim())?.content.trim() ?? null;
  useEffect(() => {
    if (!user || !firstUserTurn || claimedRef.current) return;
    claimedRef.current = true;
    api.claimChat(chatId, firstUserTurn).then((result) => {
      if (result.created) notifyChatsChanged();
    }).catch(() => {
      claimedRef.current = false;
    });
  }, [user, chatId, firstUserTurn]);

  useEffect(() => {
    if (busy) return;
    if (restoredIdsRef.current === null) {
      restoredIdsRef.current = new Set(projectedMessages.map((message) => message.id));
      for (const id of restoredIdsRef.current) capturedIdsRef.current.add(id);
      if (restoredIdsRef.current.size > 0) {
        sessionStorage.setItem(CAPTURED_IDS_PREFIX + chatId, JSON.stringify([...capturedIdsRef.current].slice(-100)));
      }
      return;
    }
    for (let index = 0; index < projectedMessages.length; index++) {
      const assistant = projectedMessages[index];
      if (assistant.role !== 'assistant' || !assistant.content || capturedIdsRef.current.has(assistant.id)) continue;
      if (restoredIdsRef.current.has(assistant.id)) continue;
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
      api.saveChatHistory(record).then(() => {
        notifyChatsChanged();
      }).catch(() => {
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

  useEffect(() => {
    const becamePaused = paused && !pausedRef.current;
    const becameLive = !paused && pausedRef.current;
    pausedRef.current = paused;
    if (becamePaused) reconnectSocket({ quiet: true, force: true });
    if (becameLive) void resumeStream().catch(() => {});
  }, [paused, reconnectSocket, resumeStream]);

  useEffect(() => {
    if (paused || socketState !== 'open') return;
    void resumeStream().catch(() => {});
  }, [paused, socketState, resumeStream]);

  const pauseTurn = useCallback(() => {
    setPaused(true);
  }, []);

  const startTurn = useCallback(() => {
    setPaused(false);
  }, []);

  const send = useCallback((raw: string) => {
    const question = raw.trim();
    if (!question || busy || scopeLocked) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    setInput('');
    setProgressStatus('Starting…');
    if (paused) setPaused(false);
    sendMessage({ text: question });
  }, [busy, paused, scopeLocked, sendMessage]);

  const canShare = projectedMessages.some((message) => message.role === 'assistant' && message.content);
  const shareChat = async () => {
    setShareBusy(true);
    setShareError(null);
    try {
      const turns: ShareChatMessage[] = projectedMessages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.sql ? { sql: message.sql } : {}),
        ...(message.ts ? { ts: message.ts } : {}),
        ...(message.result && !message.result.error ? {
          result: {
            columns: message.result.columns,
            rows: message.result.rows.slice(0, MAX_RENDER_ROWS),
            row_count: message.result.row_count,
            ...(message.result.truncated ? { truncated: true, limit: message.result.limit } : {}),
          },
        } : {}),
        ...(message.chart ? { chart: message.chart } : {}),
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
      setOnTimeline(Boolean(response.on_timeline));
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
    setOnTimeline(false);
  };

  const accessBlocked = chatAccess === 'unauthorized' || chatAccess === 'forbidden';
  const composerBlocked = accessBlocked || scopeLocked;
  const showWelcome = projectedMessages.length === 0 && !accessBlocked && !isSavedChat && !scopeLocked;
  const showSavedLoading = projectedMessages.length === 0 && isSavedChat && (chatAccess === 'unknown' || backupState === 'loading');
  const showSavedEmpty = projectedMessages.length === 0 && isSavedChat && chatAccess === 'ok' && backupState === 'missing' && !scopeLocked;

  const pendingConsumedRef = useRef(false);
  useEffect(() => {
    if (pendingConsumedRef.current) return;
    if (busy || disconnected || composerBlocked || socketState !== 'open') return;
    const pending = peekPendingPrompt();
    if (!pending) {
      pendingConsumedRef.current = true;
      return;
    }
    // Defer so React Strict Mode's mount→cleanup→remount cycle can cancel the
    // first attempt without clearing the stash before the lasting mount sends.
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      pendingConsumedRef.current = true;
      clearPendingPrompt();
      send(pending);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composerBlocked, busy, disconnected, send, socketState]);

  useEffect(() => {
    if (!accessBlocked) return;
    // Stop PartySocket's reconnect storm once we know this chat is auth-gated.
    try {
      agent.close?.(1000, 'chat access denied');
    } catch {
      /* ignore */
    }
  }, [accessBlocked, agent]);

  return (
    <section className="ai-chat">
      <header className="ai-head" aria-label="Chat controls">
        <section className="ai-head-actions">
          <ChatDeleteControl chatId={chatId} onNewChat={onNewChat} />
          <IconButton
            variant="ghost"
            size="sm"
            label="Share chat"
            icon={<Share2 size={16} />}
            tooltip={canShare ? 'Share chat' : 'Share available after the first answer'}
            isDisabled={!canShare || busy || accessBlocked}
            isLoading={shareBusy}
            onClick={shareChat}
          />
          <IconButton variant="ghost" size="sm" label="New chat" icon={<SquarePen size={16} />} tooltip="New chat" onClick={onNewChat} />
        </section>
      </header>

      {disconnected && !accessBlocked && (
        <div className={`ai-conn${socketState === 'offline' ? ' offline' : ''}`} role="status" aria-live="polite">
          <StatusDot
            variant={socketState === 'offline' ? 'warning' : 'accent'}
            label={socketState === 'offline' ? 'Offline' : 'Reconnecting'}
            isPulsing
          />
          <span>{socketState === 'offline' ? 'Offline — reconnecting when you are back online.' : 'Connection lost — reconnecting…'}</span>
        </div>
      )}

      {!accessBlocked && <ChatContextStrip chatId={chatId} frames={frames} refreshKey={researchRefreshKey} />}

      <section className="ai-messages" ref={scrollRef}>
        {showSavedLoading && (
          <section className="ai-welcome ai-chat-gate" aria-busy="true">
            <div className="ai-chat-loading-body">
              <Spinner size="md" />
              <span>Opening chat…</span>
            </div>
          </section>
        )}

        {chatAccess === 'unauthorized' && (
          <section className="ai-welcome ai-chat-gate">
            <header className="ai-welcome-hero">
              <h1 className="ai-welcome-title">Sign in to view this chat</h1>
              <p className="ai-welcome-data">
                This conversation is saved to an account. Sign in with the same Google account to load the transcript.
              </p>
              <Button
                variant="primary"
                label="Sign in"
                onClick={() => {
                  void signInWithGoogle().catch((err) => {
                    console.error('Google sign-in failed', err);
                  });
                }}
              />
            </header>
          </section>
        )}

        {chatAccess === 'forbidden' && (
          <section className="ai-welcome ai-chat-gate">
            <header className="ai-welcome-hero">
              <h1 className="ai-welcome-title">Chat unavailable</h1>
              <p className="ai-welcome-data">
                This saved chat belongs to another account. Start a new chat or open one from your history.
              </p>
              <Button variant="secondary" label="New chat" onClick={onNewChat} />
            </header>
          </section>
        )}

        {showSavedEmpty && (
          <section className="ai-welcome ai-chat-gate">
            <header className="ai-welcome-hero">
              <h1 className="ai-welcome-title">
                {isPreviewApi ? 'Transcript not in this preview' : 'Empty chat'}
              </h1>
              <p className="ai-welcome-data">
                {isPreviewApi
                  ? 'Preview and production share account ownership, but each keeps its own live chat storage. Open this chat on production to see the transcript, or ask a follow-up here to continue in preview.'
                  : 'This saved chat has no messages yet. Ask a question below to continue it.'}
              </p>
              {isPreviewApi && (
                <Button
                  variant="primary"
                  label="Open on production"
                  onClick={() => { window.location.href = prodChatUrl; }}
                />
              )}
            </header>
          </section>
        )}

        {showWelcome && (
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
                <button key={example} className="ai-example-card" onClick={() => send(example)} disabled={busy || disconnected}>
                  <span>{example}</span>
                  <span className="ai-example-arrow" aria-hidden="true">↗</span>
                </button>
              ))}
            </nav>
          </section>
        )}

        {projectedMessages.map((message) => {
          const isLive = message.role === 'assistant' && message.id === liveAssistantId;
          return (
            <div key={message.id} className={`ai-msg ai-${message.role}`}>
              {message.role === 'assistant' && <span className="ai-msg-mark" aria-hidden="true">λ</span>}
              <div className="ai-bubble">
                {isLive && (
                  <TurnProgress
                    status={status}
                    reasoning={reasoning}
                    tools={tools}
                    writing={writing && !message.content}
                    onAction={paused ? startTurn : pauseTurn}
                    action={paused ? 'start' : 'stop'}
                    thinkingRef={thinkingRef}
                  />
                )}
                {message.content && (
                  message.role === 'assistant'
                    ? <div className="ai-text"><Markdown>{message.content}</Markdown></div>
                    : <div className="ai-text">{message.content}</div>
                )}
                {message.role === 'assistant' && message.reasoning && !isLive && (
                  <details className="ai-thinking ai-thinking-done">
                    <summary>Thinking</summary>
                    <div className="ai-thinking-body">{message.reasoning}</div>
                  </details>
                )}
                {message.chart && message.result && <ChartView result={message.result} spec={message.chart} />}
                {message.sql && (
                  isLive ? (
                    <div className="ai-sql">
                      <div className="ai-sql-head">
                        <span>SQL</span>
                        <span className="ai-sql-actions">
                          <CopyButton text={message.sql} />
                          <Tooltip content="Open in Data" hasHoverIndication={false}>
                            <button onClick={() => navigate({ to: '/data', search: { sql: message.sql!, item: 'query' } })}>Open in Data ↗</button>
                          </Tooltip>
                        </span>
                      </div>
                      <pre>{message.sql}</pre>
                    </div>
                  ) : (
                    <details className="ai-sql ai-sql-collapsible">
                      <summary className="ai-sql-head">
                        <span>SQL</span>
                        <span
                          className="ai-sql-actions"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <CopyButton text={message.sql} />
                          <Tooltip content="Open in Data" hasHoverIndication={false}>
                            <button onClick={() => navigate({ to: '/data', search: { sql: message.sql!, item: 'query' } })}>Open in Data ↗</button>
                          </Tooltip>
                        </span>
                      </summary>
                      <pre>{message.sql}</pre>
                    </details>
                  )
                )}
                {message.result && (
                  message.chart ? (
                    <details className="ai-result-details">
                      <summary>Query result ({message.result.row_count.toLocaleString()} rows)</summary>
                      <ResultTable result={message.result} />
                    </details>
                  ) : (
                    <ResultTable result={message.result} />
                  )
                )}
                {message.role === 'assistant' && !isLive && !message.content && (message.sql || message.result || message.chart) && (
                  <div className="ai-no-answer">The model produced the data above but no written answer for this turn.</div>
                )}
                {message.role === 'assistant' && !isLive && (message.ts !== undefined || message.model) && (
                  <ChatMessageMetadata
                    timestamp={message.ts !== undefined ? <Timestamp value={message.ts / 1000} format="time" /> : undefined}
                    footer={message.model}
                  />
                )}
              </div>
            </div>
          );
        })}

        {visibleError && !busy && !paused && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">λ</span>
            <div className="ai-bubble">
              <div className="ai-err">{visibleError}</div>
              {scopeLocked && (
                <div className="ai-scope-lock-hint">
                  <span>This chat only answers market-data questions. Start a new chat for a finance ask.</span>
                  <Button variant="secondary" label="New chat" onClick={onNewChat} />
                </div>
              )}
            </div>
          </div>
        )}

        {(busy || paused) && !liveAssistantId && (
          <div className="ai-msg ai-assistant">
            <span className="ai-msg-mark" aria-hidden="true">λ</span>
            <div className="ai-bubble">
              <TurnProgress
                status={status}
                reasoning={reasoning}
                tools={tools}
                writing={writing}
                action={paused ? 'start' : 'stop'}
                onAction={paused ? startTurn : pauseTurn}
                thinkingRef={thinkingRef}
              />
            </div>
          </div>
        )}
      </section>

      <footer className="ai-composer-wrap">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={send}
          isDisabled={busy || disconnected || composerBlocked}
          placeholder={
            scopeLocked
              ? 'No data to answer — start a new chat'
              : accessBlocked
                ? (chatAccess === 'forbidden' ? 'Chat unavailable' : 'Sign in to continue this chat…')
                : socketState === 'offline'
                  ? 'Waiting for network…'
                  : socketState === 'reconnecting'
                    ? 'Reconnecting…'
                    : paused
                      ? 'Start to resume, or ask a follow-up…'
                      : 'Ask about liquidity, volatility, or a ticker…'
          }
          sendButton={<ChatSendButton />}
        />
      </footer>

      <Dialog isOpen={shareOpen} onOpenChange={(open) => !open && closeShareDialog()} width={480}>
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
              <Switch
                className="ai-share-publish"
                label="Post to public timeline"
                description={shareResult.can_publish
                  ? 'Anyone visiting the site will see this chat on the home feed, attributed to your handle.'
                  : 'Sign in with a public handle before sharing to post chats on the timeline. The link still works for anyone you send it to.'}
                value={onTimeline}
                onChange={setOnTimeline}
                isDisabled={!shareResult.can_publish}
                disabledMessage={shareResult.can_publish
                  ? undefined
                  : 'Sign in with a public handle, then share again to post this chat on the timeline.'}
                changeAction={async (checked) => {
                  if (!shareResult.can_publish) return;
                  if (checked) await api.publishTimeline(shareResult.share_id);
                  else await api.unpublishTimeline(shareResult.share_id);
                }}
                labelSpacing="spread"
                width="100%"
              />
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
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = authClient.useSession();
  const routeChatId = parseChatId(location.pathname.match(/^\/chat\/([^/]+)$/)?.[1]);
  const [liveId, setLiveId] = useState(ensureLiveChatId);
  const chatId = routeChatId ?? liveId;
  // Remount when the signed-in user changes so get-messages re-runs with the
  // session cookie instead of caching an anonymous 401 for an owned chat.
  const sessionKey = session?.user?.id ?? 'anon';
  useEffect(() => {
    rememberChatId(chatId);
  }, [chatId]);
  const newChat = useCallback(() => {
    const created = startNewChatId();
    setLiveId(created);
    if (routeChatId) void navigate({ to: '/chat' });
  }, [navigate, routeChatId]);

  // Saved chats may be account-owned — wait for auth before the agent
  // hydrates so we don't flash the welcome screen on a 401.
  if (routeChatId && isPending) {
    return <ChatLoadingState />;
  }

  return (
    <Suspense fallback={<ChatLoadingState />}>
      <AiChatSession
        key={`${chatId}:${sessionKey}`}
        chatId={chatId}
        isSavedChat={Boolean(routeChatId)}
        onNewChat={newChat}
      />
    </Suspense>
  );
}

export default AiChat;
