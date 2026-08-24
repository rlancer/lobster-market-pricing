/**
 * Shared palette for chart encodings + markdown color legends.
 * Human-readable names let multimodal probes map color → ticker without OCR.
 */

export interface PaletteSwatch {
  hex: string;
  name: string;
}

/** Stable 20-color panel palette (order matches synthetic series index). */
export const PANEL_PALETTE: PaletteSwatch[] = [
  { hex: '#35D0BA', name: 'teal' },
  { hex: '#4C8DFF', name: 'blue' },
  { hex: '#E0A84C', name: 'gold' },
  { hex: '#C56E8F', name: 'rose' },
  { hex: '#9B7EE0', name: 'violet' },
  { hex: '#58B6C9', name: 'cyan' },
  { hex: '#E07A5F', name: 'coral' },
  { hex: '#81B29A', name: 'sage' },
  { hex: '#F2CC8F', name: 'sand' },
  { hex: '#3D405B', name: 'slate' },
  { hex: '#E9C46A', name: 'amber' },
  { hex: '#2A9D8F', name: 'seafoam' },
  { hex: '#E76F51', name: 'terracotta' },
  { hex: '#264653', name: 'ink' },
  { hex: '#A8DADC', name: 'mist' },
  { hex: '#457B9D', name: 'steel' },
  { hex: '#1D3557', name: 'navy' },
  { hex: '#F4A261', name: 'peach' },
  { hex: '#2B2D42', name: 'charcoal' },
  { hex: '#8D99AE', name: 'pewter' },
];

export function paletteHex(index: number): string {
  return PANEL_PALETTE[index % PANEL_PALETTE.length]!.hex;
}

export function paletteName(index: number): string {
  return PANEL_PALETTE[index % PANEL_PALETTE.length]!.name;
}
