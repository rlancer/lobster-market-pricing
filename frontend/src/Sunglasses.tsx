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

/** Round header avatar: brand glasses on a smug little face, no Google photo. */
export function ProfileSunglasses({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="16"
        cy="16"
        r="15"
        fill="var(--color-accent-muted)"
        stroke="var(--color-border-emphasized)"
        strokeWidth="1.25"
      />
      <g transform="translate(16 13.2) scale(0.78) translate(-48 -30)">
        <BrandGlasses />
      </g>
      <path
        d="M12.5 22.5Q16 25 19.5 22.5"
        fill="none"
        stroke="var(--color-text-primary)"
        strokeLinecap="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}