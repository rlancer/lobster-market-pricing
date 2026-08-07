// Official OpenRouter brand mark.
// Source: https://openrouter.ai/brand/v2/openrouter-glyph-light.svg
// The mark is reproduced verbatim (viewBox + path) so it renders identically
// to the asset on openrouter.ai, without a runtime fetch. Sizing is controlled
// by the consumer via the `className`/`width`/`height` props.
export function OpenRouterLogo({
  className,
  width,
  height,
  color = '#7F3DFF',
  title = 'OpenRouter',
}: {
  className?: string;
  width?: number | string;
  height?: number | string;
  color?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 401.4 293.7"
      className={className}
      width={width}
      height={height}
      role="img"
      aria-label={title}
      style={{ display: 'block' }}
    >
      <title>{title}</title>
      <path
        fill={color}
        d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z"
      />
    </svg>
  );
}
