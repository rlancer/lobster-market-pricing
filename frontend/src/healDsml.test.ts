import { describe, expect, it } from 'vitest';
import { healAssistantContentFromDsml } from './healDsml';
import { looksLikeDsmlToolMarkup, parseDsmlToolCalls, stripDsmlToolMarkup } from './dsml';

const DSML = '\uFF5CDSML\uFF5C';

function samplePublishDeskDsml(): string {
  return [
    `<${DSML}tool_calls>`,
    `<${DSML}invoke name="publish_desk">`,
    `<${DSML}parameter name="fundamental" string="true">MRNA is the marquee catalyst (+12% today) while semis lag.</${DSML}parameter>`,
    `<${DSML}parameter name="options" string="true">NVDA 220 line prints heavy two-sided flow; VSAT carries 411K OI.</${DSML}parameter>`,
    `<${DSML}parameter name="overview" string="true">The index fade is a sector rotation, not broad de-grossing: SPY soft, QQQ lagging on semis/AI.</${DSML}parameter>`,
    `<${DSML}parameter name="technical" string="true">Three-session fade in SPY/QQQ with damage concentrated in large-cap tech.</${DSML}parameter>`,
    `<${DSML}parameter name="risk" string="true">Gap risk into the next CPI print; keep size modest until breadth stabilizes.</${DSML}parameter>`,
    `</${DSML}invoke>`,
    `</${DSML}tool_calls>`,
  ].join('\n');
}

describe('dsml', () => {
  it('parses and strips DeepSeek DSML tool envelopes', () => {
    const raw = samplePublishDeskDsml();
    expect(looksLikeDsmlToolMarkup(raw)).toBe(true);
    const calls = parseDsmlToolCalls(raw);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('publish_desk');
    expect(String(calls[0]?.args.overview)).toMatch(/sector rotation/);
    expect(stripDsmlToolMarkup(raw)).toBe('');
  });
});

describe('healAssistantContentFromDsml', () => {
  it('recovers desk overview and hides markup', () => {
    const healed = healAssistantContentFromDsml(samplePublishDeskDsml());
    expect(healed.desk?.overview).toMatch(/sector rotation/);
    expect(healed.content).toBe(healed.desk?.overview);
    expect(looksLikeDsmlToolMarkup(healed.content)).toBe(false);
  });

  it('recovers render_chart specs from DSML', () => {
    const raw = [
      'Chart next.',
      `<${DSML}tool_calls>`,
      `<${DSML}invoke name="render_chart">`,
      `<${DSML}parameter name="kind" string="true">line</${DSML}parameter>`,
      `<${DSML}parameter name="x" string="true">strike</${DSML}parameter>`,
      `<${DSML}parameter name="y" string="true">implied_vol</${DSML}parameter>`,
      `</${DSML}invoke>`,
      `</${DSML}tool_calls>`,
    ].join('\n');
    const healed = healAssistantContentFromDsml(raw);
    expect(healed.chart).toEqual({ kind: 'line', x: 'strike', y: 'implied_vol' });
    expect(healed.content).toBe('Chart next.');
  });
});
