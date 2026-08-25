/**
 * DeepSeek DSML tool-call markup — mirror of worker/src/dsml.ts.
 * Keep strip/parse in sync so live chat can heal leaked markup without a Worker round-trip.
 */

/** Fullwidth vertical line U+FF5C — DeepSeek's DSML delimiter token. */
const DSML = '\uFF5CDSML\uFF5C';

const TOOL_CALLS_RE = new RegExp(
  `<${DSML}tool_calls>([\\s\\S]*?)</${DSML}tool_calls>`,
  'g',
);
const INVOKE_RE = new RegExp(
  `<${DSML}invoke\\s+name="([^"]+)">([\\s\\S]*?)</${DSML}invoke>`,
  'g',
);
const PARAM_RE = new RegExp(
  `<${DSML}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?>([\\s\\S]*?)</${DSML}parameter>`,
  'g',
);

export type DsmlToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export function looksLikeDsmlToolMarkup(text: string): boolean {
  if (!text) return false;
  return text.includes(`<${DSML}tool_calls>`) || text.includes(`<${DSML}invoke`);
}

function parseParamValue(raw: string, stringAttr: string | undefined): unknown {
  const value = raw.trim();
  if (stringAttr === 'true') return value;
  if (stringAttr === 'false') {
    if (!value) return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value) || value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      /* fall through */
    }
  }
  return value;
}

function parseInvokeBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  PARAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAM_RE.exec(body)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    args[name] = parseParamValue(match[3] ?? '', match[2]);
  }
  return args;
}

export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  if (!looksLikeDsmlToolMarkup(text)) return [];
  const out: DsmlToolCall[] = [];
  TOOL_CALLS_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  const bodies: string[] = [];
  while ((block = TOOL_CALLS_RE.exec(text)) !== null) {
    bodies.push(block[1] ?? '');
  }
  if (!bodies.length) bodies.push(text);

  for (const body of bodies) {
    INVOKE_RE.lastIndex = 0;
    let invoke: RegExpExecArray | null;
    while ((invoke = INVOKE_RE.exec(body)) !== null) {
      const name = invoke[1]?.trim();
      if (!name) continue;
      out.push({ name, args: parseInvokeBody(invoke[2] ?? '') });
    }
  }
  return out;
}

export function stripDsmlToolMarkup(text: string): string {
  if (!looksLikeDsmlToolMarkup(text)) return text;
  let out = text.replace(TOOL_CALLS_RE, '');
  out = out.replace(
    new RegExp(`<${DSML}invoke\\s+name="[^"]+">[\\s\\S]*?</${DSML}invoke>`, 'g'),
    '',
  );
  out = out.replace(new RegExp(`</?${DSML}[^>]*>`, 'g'), '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
