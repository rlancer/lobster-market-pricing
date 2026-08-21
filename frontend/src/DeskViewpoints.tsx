import { Markdown } from '@astryxdesign/core';

export interface DeskBrief {
  fundamental?: string;
  technical?: string;
  options?: string;
  risk?: string;
  macro?: string;
  overview: string;
}

const VIEWPOINTS: { id: keyof Omit<DeskBrief, 'overview'>; label: string; hint: string }[] = [
  { id: 'fundamental', label: 'Fundamental', hint: 'Earnings, filings, business quality' },
  { id: 'technical', label: 'Technical', hint: 'Price, volume, trend structure' },
  { id: 'options', label: 'Options', hint: 'IV, liquidity, tradable structure' },
  { id: 'risk', label: 'Risk', hint: 'Downside, sizing, what breaks' },
  { id: 'macro', label: 'Macro', hint: 'Rates, Fed, factor regime' },
];

const STUB_RE = /^(placeholder|tbd|todo|n\/?a|none|null|undefined|\.{1,3}|x+|-+)$/i;

function isPresentTake(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length < 40) return false;
  if (STUB_RE.test(trimmed)) return false;
  return true;
}

/**
 * Active specialist panels + overview — shared by live chat, share, and timeline.
 * Only published specialists render; overview weighs disagreement among them.
 */
export function DeskViewpoints({
  desk,
  showOverview = true,
}: {
  desk: DeskBrief;
  /** When false, only the specialist panels (overview already in message text). */
  showOverview?: boolean;
}) {
  const active = VIEWPOINTS.filter((viewpoint) => isPresentTake(desk[viewpoint.id]));
  const angleNote = active.length === 1
    ? 'one angle'
    : `${active.length || 'shared'} angles`;

  return (
    <section className="ai-desk" aria-label="Analyst desk viewpoints">
      <header className="ai-desk-head">
        <span className="ai-desk-kicker">Analyst desk</span>
        <span className="ai-desk-note">Shared evidence · {angleNote}</span>
      </header>
      <section className="ai-desk-viewpoints">
        {active.map((viewpoint) => (
          <details key={viewpoint.id} className="ai-desk-panel" open>
            <summary>
              <span className="ai-desk-panel-label">{viewpoint.label}</span>
              <span className="ai-desk-panel-hint">{viewpoint.hint}</span>
            </summary>
            <div className="ai-desk-panel-body">
              <Markdown>{desk[viewpoint.id]!}</Markdown>
            </div>
          </details>
        ))}
      </section>
      {showOverview && isPresentTake(desk.overview) ? (
        <section className="ai-desk-overview" aria-label="Desk overview">
          <header className="ai-desk-overview-head">Overview</header>
          <div className="ai-desk-overview-body">
            <Markdown>{desk.overview}</Markdown>
          </div>
        </section>
      ) : null}
    </section>
  );
}

export function isDeskBrief(value: unknown): value is DeskBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (!isPresentTake(rec.overview)) return false;
  const specialistIds = VIEWPOINTS.map((viewpoint) => viewpoint.id);
  const specialists = specialistIds
    .map((id) => rec[id])
    .filter((field) => isPresentTake(field));
  if (specialists.length === 0) return false;
  return true;
}
