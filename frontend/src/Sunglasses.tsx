function BrandGlasses() {
  return (
    <>
      <g
        fill="var(--color-background-body)"
        stroke="var(--color-text-primary)"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <rect x="39" y="27" width="8" height="6" rx="2" />
        <rect x="49" y="27" width="8" height="6" rx="2" />
        <path d="M47 29.5H49M39 29L37 28M57 29L59 28" fill="none" />
      </g>
      <g fill="none" stroke="var(--color-icon-blue)" strokeLinecap="round" strokeWidth="1.2">
        <path d="M41 29L43 28M51 29L53 28" />
      </g>
    </>
  );
}

export function Sunglasses({
  className,
  width = 56,
  height = 24,
}: {
  className?: string;
  width?: number | string;
  height?: number | string;
}) {
  return (
    <svg
      viewBox="34 24 28 12"
      className={className}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <BrandGlasses />
    </svg>
  );
}

/** Assistant message avatar — brand glasses in the chat mark slot. */
export function AssistantMark({ className = 'ai-msg-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <Sunglasses className="ai-msg-mark-glasses" width={20} height={9} />
    </span>
  );
}

/**
 * Round header avatar: purpose-built brand shades on a soft disc.
 * Drawn for 32×32 (not a scaled lobster-logo crop) so it stays crisp in the
 * topbar — no Google photo, no cartoon smile.
 */
export function ProfileSunglasses({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="16" cy="16" r="16" fill="var(--color-accent-muted)" />
      {/* Optical center sits slightly above mid so the mark reads balanced. */}
      <g
        fill="var(--color-background-body)"
        stroke="var(--color-text-primary)"
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeWidth="1.2"
      >
        <rect x="4.5" y="11.5" width="9.75" height="7.25" rx="3.4" />
        <rect x="17.75" y="11.5" width="9.75" height="7.25" rx="3.4" />
        <path d="M14.25 15.1H17.75" fill="none" />
        <path d="M4.5 14.15L2.6 13M27.5 14.15L29.4 13" fill="none" />
      </g>
      <g fill="none" stroke="var(--color-icon-blue)" strokeLinecap="round" strokeWidth="1.15">
        <path d="M7 13.85L9.4 12.7M20.25 13.85L22.65 12.7" />
      </g>
    </svg>
  );
}