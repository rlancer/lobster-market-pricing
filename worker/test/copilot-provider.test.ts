import assert from 'node:assert/strict';
import test from 'node:test';
import { isStepCount, streamText, tool } from 'ai';
import {
  COPILOT_TOOL_INPUT_SCHEMAS,
  createCopilotModel,
} from '../src/copilot-contract.ts';

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const modelSlug = 'test/provider-model';
const toolCallId = 'call_query_1';

function firstStep(): Response {
  return sse([
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelSlug,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          reasoning: 'Inspecting the lake schema. ',
          tool_calls: [{
            index: 0,
            id: toolCallId,
            type: 'function',
            function: { name: 'run_query', arguments: '{"sql":"SELECT 1 AS value LIMIT 1"}' },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelSlug,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    },
  ]);
}

function finalStep(): Response {
  return sse([
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: modelSlug,
      choices: [{
        index: 0,
        delta: { role: 'assistant', reasoning: 'The query succeeded. ', content: 'The lake returned value 1.' },
        finish_reason: null,
      }],
    },
    {
      id: 'chatcmpl-2',
      object: 'chat.completion.chunk',
      created: 2,
      model: modelSlug,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    },
  ]);
}

test('OpenRouter request and UI stream preserve Copilot contracts', async () => {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let call = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    call += 1;
    return call === 1 ? firstStep() : finalStep();
  };

  const tools = {
    run_query: tool({
      description: 'Execute a lake query.',
      inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.run_query,
      execute: async ({ sql }) => ({ ok: true, sql, rows: [{ value: 1 }] }),
    }),
    check_schema: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.check_schema, execute: async () => ({ ok: true }) }),
    list_frames: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.list_frames, execute: async () => ({ ok: true }) }),
    filter_frame: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.filter_frame, execute: async () => ({ ok: true }) }),
    refresh_frame: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.refresh_frame, execute: async () => ({ ok: true }) }),
    render_chart: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.render_chart, execute: async () => ({ ok: true }) }),
    get_news: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_news, execute: async () => ({ ok: true }) }),
    web_search: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.web_search, execute: async () => ({ ok: true }) }),
    eco_calendar: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.eco_calendar, execute: async () => ({ ok: true }) }),
    research_ticker: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.research_ticker, execute: async () => ({ ok: true }) }),
    lookup_symbols: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.lookup_symbols, execute: async () => ({ ok: true }) }),
    publish_desk: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.publish_desk, execute: async () => ({ ok: true }) }),
    suggest_trades: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.suggest_trades, execute: async () => ({ ok: true }) }),
    get_paper_portfolio: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_paper_portfolio, execute: async () => ({ ok: true }) }),
    get_schwab_portfolio: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_portfolio, execute: async () => ({ ok: true }) }),
    get_schwab_quotes: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_schwab_quotes, execute: async () => ({ ok: true }) }),
    get_bot_trades: tool({ inputSchema: COPILOT_TOOL_INPUT_SCHEMAS.get_bot_trades, execute: async () => ({ ok: true }) }),
  };
  const model = createCopilotModel(
    { OPEN_ROUTER_KEY: 'server-secret', COPILOT_MODEL: modelSlug },
    'https://example.pages.dev',
    mockFetch,
  );
  const result = streamText({
    model,
    messages: [{ role: 'user', content: 'Read the lake.' }],
    tools,
    stopWhen: isStepCount(2),
    providerOptions: { openrouter: { reasoning: { effort: 'high' } } },
  });
  const chunks = [];
  for await (const chunk of result.toUIMessageStream({ sendReasoning: true })) chunks.push(chunk);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer server-secret');
  assert.equal(requests[0].headers.get('http-referer'), 'https://example.pages.dev');
  assert.equal(requests[0].headers.get('x-openrouter-title'), 'Open Interest Options Workspace');
  assert.equal(requests[0].body.model, modelSlug);
  assert.equal(requests[0].body.parallel_tool_calls, false);
  assert.deepEqual(requests[0].body.reasoning, { effort: 'high' });

  const requestTools = requests[0].body.tools as Array<{ function: { name: string; parameters: unknown } }>;
  assert.deepEqual(requestTools.map((entry) => entry.function.name).sort(), Object.keys(COPILOT_TOOL_INPUT_SCHEMAS).sort());
  assert.ok(requestTools.every((entry) => entry.function.parameters && typeof entry.function.parameters === 'object'));

  const types = chunks.map((chunk) => chunk.type);
  assert.ok(types.includes('reasoning-delta'), `missing reasoning delta: ${types.join(', ')}`);
  assert.ok(types.includes('tool-input-delta'), `missing tool input delta: ${types.join(', ')}`);
  assert.ok(types.includes('tool-output-available'), `missing tool output: ${types.join(', ')}`);
  assert.ok(types.includes('text-delta'), `missing final text delta: ${types.join(', ')}`);
  assert.equal(chunks.find((chunk) => chunk.type === 'tool-input-available')?.toolCallId, toolCallId);
});
