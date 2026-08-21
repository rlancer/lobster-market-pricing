/**
 * Collapse consecutive assistant turns from chatRecovery retries into one bubble.
 * Stalled multi-analyst desk turns used to leave user → assistant → assistant
 * stacks in live chat and on /share.
 */

export type CoalesceableAssistant = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  sql?: string | null;
  result?: unknown;
  chart?: unknown;
  desk?: { overview?: string } | null;
  trades?: unknown;
  model?: string;
  ts?: number;
  id?: string;
  error?: string;
};

function hasSubstance(message: CoalesceableAssistant): boolean {
  return Boolean(
    message.content?.trim()
    || message.reasoning?.trim()
    || message.sql?.trim()
    || message.desk
    || message.trades
    || message.chart
    || message.result
    || message.error,
  );
}

function mergeAssistants<T extends CoalesceableAssistant>(earlier: T, later: T): T {
  const desk = later.desk ?? earlier.desk;
  const content = (
    (desk && typeof desk.overview === 'string' && desk.overview.trim())
    || later.content?.trim()
    || earlier.content
    || ''
  ).trim();
  return {
    ...earlier,
    ...later,
    id: later.id ?? earlier.id,
    content: content || ((later.reasoning || earlier.reasoning) ? '(see reasoning)' : ''),
    reasoning: later.reasoning?.trim() || earlier.reasoning,
    sql: later.sql || earlier.sql,
    result: later.result ?? earlier.result,
    chart: later.chart ?? earlier.chart,
    desk,
    trades: later.trades ?? earlier.trades,
    model: later.model || earlier.model,
    ts: later.ts ?? earlier.ts,
    error: later.error || earlier.error,
  };
}

export function coalesceAssistantMessages<T extends CoalesceableAssistant>(messages: T[]): T[] {
  const out: T[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') {
      out.push(message);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.role === 'assistant') {
      out[out.length - 1] = mergeAssistants(prev, message);
      continue;
    }
    if (!hasSubstance(message)) continue;
    out.push(message);
  }
  return out;
}
