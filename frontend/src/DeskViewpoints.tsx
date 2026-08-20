import { Markdown } from '@astryxdesign/core';

export interface DeskBrief {
  fundamental: string;
  technical: string;
  options: string;
  overview: string;
}

const VIEWPOINTS: { id: keyof Omit<DeskBrief, 'overview'>; label: string; hint: string }[] = [
  { id: 'fundamental', label: 'Fundamental', hint: 'Earnings, filings, business quality' },
  { id: 'technical', label: 'Technical', hint: 'Price, volume, trend structure' },
  { id: 'options', label: 'Options', hint: 'IV, liquidity, tradable structure' },
];

/**
 * Three specialist panels + overview — shared by live chat, share, and timeline.
 * Specialists share the same lake evidence; overview weighs disagreement.
 */
export function DeskViewpoints({
  desk,
  showOverview = true,
}: {
  desk: DeskBrief;
  /** When false, only the three specialist panels (overview already in message text). */
  showOverview?: boolean;
}) {
  return (
    <section className="ai-desk" aria-label="Analyst desk viewpoints">
      <header className="ai-desk-head">
        <span className="ai-desk-kicker">Analyst desk</span>
        <span className="ai-desk-note">Shared evidence · three angles</span>
      </header>
      <section className="ai-desk-viewpoints">
        {VIEWPOINTS.map((viewpoint) => (
          <details key={viewpoint.id} className="ai-desk-panel" open>
            <summary>
              <span className="ai-desk-panel-label">{viewpoint.label}</span>
              <span className="ai-desk-panel-hint">{viewpoint.hint}</span>
            </summary>
            <div className="ai-desk-panel-body">
              <Markdown>{desk[viewpoint.id]}</Markdown>
            </div>
          </details>
        ))}
      </section>
      {showOverview && desk.overview ? (
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
  return (
    typeof rec.fundamental === 'string' && rec.fundamental.trim().length > 0
    && typeof rec.technical === 'string' && rec.technical.trim().length > 0
    && typeof rec.options === 'string' && rec.options.trim().length > 0
    && typeof rec.overview === 'string' && rec.overview.trim().length > 0
  );
}
