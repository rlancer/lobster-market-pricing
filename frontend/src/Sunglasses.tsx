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
 * topbar. Custom photos replace this via UserAvatar; Google OAuth pictures
 * are never shown here.
 */
export function ProfileSunglasses({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Card base + accent wash — muted alone disappears into the page. */}
      <circle cx="16" cy="16" r="16" fill="var(--color-background-card)" />
      <circle cx="16" cy="16" r="16" fill="var(--color-accent-muted)" />
      {/*
        Shades fill most of the badge (~78% wide). Sit a hair below center for a
        cooler, less “sticker” balance than a dead-center crop.
      */}
      <g
        fill="var(--color-background-body)"
        stroke="var(--color-text-primary)"
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeWidth="1.35"
      >
        <rect x="3.25" y="12.4" width="11" height="8" rx="3.1" />
        <rect x="17.75" y="12.4" width="11" height="8" rx="3.1" />
        <path d="M14.25 16.3H17.75" fill="none" />
        <path d="M3.25 14.9L1.6 13.75M28.75 14.9L30.4 13.75" fill="none" />
      </g>
      <g fill="none" stroke="var(--color-icon-blue)" strokeLinecap="round" strokeWidth="1.25">
        <path d="M6.1 14.55L8.7 13.25M20.8 14.55L23.4 13.25" />
      </g>
    </svg>
  );
}