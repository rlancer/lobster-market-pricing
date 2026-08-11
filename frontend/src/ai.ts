import { API_BASE, type QueryResult } from './api';
import type { ChartSpec } from './Chart';

export interface DataFrame {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
}

export interface ChatTextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentProgress =
  | { kind: 'status'; status: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'tool_start'; name: string; display: string; callId: string }
  | { kind: 'tool_args'; name: string; callId: string; args: string }
  | { kind: 'tool_end'; name: string; callId: string; ok: boolean; summary: string }
  | { kind: 'answer' }
  | { kind: 'error'; message: string };

export interface AskCallbacks {
  onStatus?: (status: string) => void;
  onProgress?: (progress: AgentProgress) => void;
}

export interface AskResult {
  answer: string;
  sql: string | null;
  result: QueryResult | null;
  chart: ChartSpec | null;
  model: string;
  frames: DataFrame[];
}

type StreamEvent = AgentProgress | ({ kind: 'result' } & AskResult);


function parseEvent(data: string): StreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('kind' in value) || typeof value.kind !== 'string') return null;
  return value as StreamEvent;
}

/** Send one chat turn to the Worker's server-side agent loop and consume its SSE stream. */
export async function askAi(
  question: string,
  chatId: string,
  history: ChatTextMessage[],
  opts: AskCallbacks = {},
): Promise<AskResult> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, chat_id: chatId, history }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Chat API ${response.status}: ${detail || response.statusText}`);
  }
  if (!response.body) throw new Error('Chat API returned no response stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AskResult | null = null;
  let streamError: string | null = null;

  const consume = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    const event = parseEvent(data);
    if (!event) return;
    if (event.kind === 'result') {
      result = {
        answer: event.answer,
        sql: event.sql,
        result: event.result,
        chart: event.chart,
        model: event.model,
        frames: event.frames,
      };
      return;
    }
    if (event.kind === 'error') streamError = event.message;
    if (event.kind === 'status') opts.onStatus?.(event.status);
    opts.onProgress?.(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consume(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error('Chat stream ended without a final result');
  return result;
}
