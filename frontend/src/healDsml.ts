/**
 * Heal DeepSeek DSML tool markup that leaked into assistant text in live chat.
 * Mirrors worker healShareTurnFromDsml — recover desk/trades/chart, strip markup.
 */
import type { ChartSpec } from './Chart';
import { isDeskBrief, type DeskBrief } from './DeskViewpoints';
import { isSuggestedTrades, type SuggestedTrades } from './SuggestedTrades';
import { looksLikeDsmlToolMarkup, parseDsmlToolCalls, stripDsmlToolMarkup } from './dsml';

function asChartSpec(value: unknown): ChartSpec | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== 'line' && kind !== 'area' && kind !== 'scatter' && kind !== 'bar') return null;
  if (typeof rec.x !== 'string' || !rec.x.trim()) return null;
  if (typeof rec.y !== 'string' || !rec.y.trim()) return null;
  const chart: ChartSpec = { kind, x: rec.x.trim(), y: rec.y.trim() };
  if (typeof rec.title === 'string' && rec.title.trim()) chart.title = rec.title.trim();
  if (typeof rec.series === 'string' && rec.series.trim()) chart.series = rec.series.trim();
  if (typeof rec.xLabel === 'string' && rec.xLabel.trim()) chart.xLabel = rec.xLabel.trim();
  if (typeof rec.yLabel === 'string' && rec.yLabel.trim()) chart.yLabel = rec.yLabel.trim();
  return chart;
}

function asDeskBrief(value: unknown): DeskBrief | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const overview = typeof rec.overview === 'string' ? rec.overview.trim() : '';
  if (!overview) return null;
  const desk: DeskBrief = { overview };
  for (const id of ['fundamental', 'technical', 'options', 'risk', 'macro'] as const) {
    const field = rec[id];
    if (typeof field === 'string' && field.trim()) desk[id] = field.trim();
  }
  return isDeskBrief(desk) ? desk : null;
}

export type HealedAssistantContent = {
  content: string;
  desk?: DeskBrief | null;
  trades?: SuggestedTrades | null;
  chart?: ChartSpec | null;
};

/**
 * When assistant text embeds DSML tool invokes, recover structured fields and
 * replace the visible body with the desk overview (or stripped prose).
 */
export function healAssistantContentFromDsml(
  content: string,
  existing?: { desk?: DeskBrief | null; trades?: SuggestedTrades | null; chart?: ChartSpec | null },
): HealedAssistantContent {
  if (!looksLikeDsmlToolMarkup(content)) {
    return { content };
  }
  const calls = parseDsmlToolCalls(content);
  let desk = existing?.desk ?? null;
  let trades = existing?.trades ?? null;
  let chart = existing?.chart ?? null;
  for (const call of calls) {
    if (call.name === 'publish_desk' && !desk) {
      desk = asDeskBrief(call.args);
    }
    if (call.name === 'suggest_trades' && !trades) {
      const candidate = call.args;
      if (isSuggestedTrades(candidate)) trades = candidate;
    }
    if (call.name === 'render_chart' && !chart) {
      chart = asChartSpec(call.args);
    }
  }
  const stripped = stripDsmlToolMarkup(content);
  const nextContent = (desk?.overview || stripped || '').trim();
  return {
    content: nextContent,
    ...(desk ? { desk } : {}),
    ...(trades ? { trades } : {}),
    ...(chart ? { chart } : {}),
  };
}
