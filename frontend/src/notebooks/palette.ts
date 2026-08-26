/**
 * Shared palette for chart encodings + markdown color legends.
 * Human-readable names let multimodal probes map color → ticker without OCR.
 * Sized for dense panels (80+ names) with unique swatch labels.
 */

export interface PaletteSwatch {
  hex: string;
  name: string;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

/** Golden-angle HSL palette with unique cNN names (no OCR collisions). */
export function buildPanelPalette(count: number): PaletteSwatch[] {
  const out: PaletteSwatch[] = [];
  for (let i = 0; i < count; i++) {
    const h = (i * 137.508) % 360;
    const s = 52 + (i % 4) * 8;
    const l = 42 + (i % 5) * 6;
    out.push({
      hex: hslToHex(h, s, l),
      name: `c${String(i + 1).padStart(2, '0')}`,
    });
  }
  return out;
}

/** Stable panel palette covering dense synthetic universes. */
export const PANEL_PALETTE: PaletteSwatch[] = buildPanelPalette(96);

export function paletteHex(index: number): string {
  return PANEL_PALETTE[index % PANEL_PALETTE.length]!.hex;
}

export function paletteName(index: number): string {
  return PANEL_PALETTE[index % PANEL_PALETTE.length]!.name;
}
