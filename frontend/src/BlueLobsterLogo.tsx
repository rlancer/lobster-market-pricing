export function BlueLobsterLogo({
  className,
  width = 40,
  height = 40,
}: {
  className?: string;
  width?: number | string;
  height?: number | string;
}) {
  return (
    <svg
      viewBox="0 0 96 96"
      className={className}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        stroke="var(--color-icon-blue)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.5"
      >
        <path d="M41 26C33 17 23 12 13 14" />
        <path d="M55 26C63 17 73 12 83 14" />
        <path d="M37 37C31 34 27 33 23 34" />
        <path d="M59 37C65 34 69 33 73 35" />
        <path d="M38 48L27 53M58 48L68 52" />
      </g>

      <g
        fill="var(--color-border-blue)"
        stroke="var(--color-icon-blue)"
        strokeLinejoin="round"
        strokeWidth="2.5"
      >
        <path d="M36 40C30 30 22 24 13 25C4 26 1 36 5 44C10 54 22 56 31 49L38 44L36 40ZM12 33C17 30 23 33 27 39C21 37 16 39 11 43C8 40 8 35 12 33Z" fillRule="evenodd" />
        <path d="M60 40C65 32 72 27 79 29C87 31 90 39 86 46C82 53 73 53 66 48L58 44L60 40ZM78 36C74 34 70 36 67 40C72 39 76 41 79 44C82 41 82 38 78 36Z" fillRule="evenodd" />
        <path d="M37 29C39 23 43 20 48 20C53 20 57 23 59 29L58 61C56 69 52 73 48 73C44 73 40 69 38 61L37 29Z" />
        <path d="M39 65C37 74 30 81 18 87C29 90 40 87 46 82L48 91L52 81C57 84 63 85 69 83C61 77 57 71 56 65C51 70 44 70 39 65Z" />
      </g>

      <g fill="none" stroke="var(--color-icon-blue)" strokeLinecap="round" strokeWidth="2">
        <path d="M38 46H58M39 57H57" />
      </g>

      <g fill="var(--color-background-body)" stroke="var(--color-icon-blue)" strokeWidth="1.5">
        <circle cx="43" cy="30" r="3.2" />
        <circle cx="53" cy="30" r="3.2" />
      </g>
      <g fill="var(--color-icon-blue)">
        <circle cx="44" cy="30" r="1.2" />
        <circle cx="52" cy="30" r="1.2" />
      </g>
      <path
        d="M42 36Q48 42 54 36"
        fill="none"
        stroke="var(--color-background-body)"
        strokeLinecap="round"
        strokeWidth="2.5"
      />
    </svg>
  );
}
