/**
 * Context-window footprint estimates for experiment representations.
 *
 * Text: chars/4 (same heuristic as Copilot approxTokens).
 * Images: OpenAI GPT-4o / GPT-4.1 “detail: high” tile formula — comparable
 * across reps even when a given provider’s bill differs slightly.
 *
 *   1. Fit inside 2048×2048 (aspect preserved; never upscale).
 *   2. If shortest side > 768, scale so shortest side = 768.
 *   3. Cover with 512×512 tiles → tokens = 85 + 170 × tiles.
 *
 * Hybrids = image tiles + markdown text tokens.
 */

export const TEXT_TOKEN_CHARS = 4;
export const VISION_BASE_TOKENS = 85;
export const VISION_TILE_TOKENS = 170;
export const VISION_TILE_PX = 512;
export const VISION_SHORT_SIDE = 768;
export const VISION_MAX_SIDE = 2048;

export const CONTEXT_ESTIMATOR_ID = 'openai-gpt4o-high-detail-tiles+chars/4';

export type ContextMode = 'text' | 'image' | 'multimodal';

export interface ContextFootprint {
  rep_id: string;
  mode: ContextMode;
  /** Estimated text tokens in the probe payload (0 for image-only). */
  text_tokens: number;
  /** Estimated vision tokens from image dimensions (0 for text-only). */
  image_tokens: number;
  /** text_tokens + image_tokens — context space used by this encoding. */
  total_tokens: number;
  image_width?: number;
  image_height?: number;
  /** Tile count after high-detail resize (images / hybrids). */
  image_tiles?: number;
  estimator: typeof CONTEXT_ESTIMATOR_ID;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / TEXT_TOKEN_CHARS);
}

/** OpenAI high-detail vision tile count after official resize steps. */
export function visionTileCount(width: number, height: number): number {
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));

  const longest = Math.max(w, h);
  if (longest > VISION_MAX_SIDE) {
    const scale = VISION_MAX_SIDE / longest;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }

  const shortest = Math.min(w, h);
  if (shortest > VISION_SHORT_SIDE) {
    const scale = VISION_SHORT_SIDE / shortest;
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }

  const tilesX = Math.ceil(w / VISION_TILE_PX);
  const tilesY = Math.ceil(h / VISION_TILE_PX);
  return Math.max(1, tilesX * tilesY);
}

export function estimateImageTokens(width: number, height: number): {
  tokens: number;
  tiles: number;
} {
  const tiles = visionTileCount(width, height);
  return {
    tiles,
    tokens: VISION_BASE_TOKENS + VISION_TILE_TOKENS * tiles,
  };
}

export function textFootprint(repId: string, body: string): ContextFootprint {
  const text_tokens = estimateTextTokens(body);
  return {
    rep_id: repId,
    mode: 'text',
    text_tokens,
    image_tokens: 0,
    total_tokens: text_tokens,
    estimator: CONTEXT_ESTIMATOR_ID,
  };
}

export function imageFootprint(
  repId: string,
  width: number,
  height: number,
): ContextFootprint {
  const { tokens, tiles } = estimateImageTokens(width, height);
  return {
    rep_id: repId,
    mode: 'image',
    text_tokens: 0,
    image_tokens: tokens,
    total_tokens: tokens,
    image_width: width,
    image_height: height,
    image_tiles: tiles,
    estimator: CONTEXT_ESTIMATOR_ID,
  };
}

export function multimodalFootprint(
  repId: string,
  textContext: string,
  width: number,
  height: number,
): ContextFootprint {
  const text_tokens = estimateTextTokens(textContext);
  const { tokens: image_tokens, tiles } = estimateImageTokens(width, height);
  return {
    rep_id: repId,
    mode: 'multimodal',
    text_tokens,
    image_tokens,
    total_tokens: text_tokens + image_tokens,
    image_width: width,
    image_height: height,
    image_tiles: tiles,
    estimator: CONTEXT_ESTIMATOR_ID,
  };
}

export function formatContextTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n / 1_000)}k`;
}
