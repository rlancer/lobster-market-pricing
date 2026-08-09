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
    </svg>
  );
}