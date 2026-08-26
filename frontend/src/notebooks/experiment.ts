/**
 * Shared experiment types for the text-vs-image notebook UI + API client.
 */

import type { HybridRepId } from './hybridRepresentations.ts';
import type { ImageRepId } from './imageRepresentations.ts';
import type { TextRepId } from './textRepresentations.ts';

/**
 * Bump whenever prompts, scorers, representations, or matrix composition
 * change. Public comparisons only combine runs with this exact design.
 */
export const EXPERIMENT_DESIGN_ID = 'text-vs-image-v3';

export type RepresentationId = TextRepId | ImageRepId | HybridRepId;

export type ProbeMode = 'text' | 'image' | 'multimodal';

export interface ProbeRequest {
  model?: string;
  question: string;
  mode: ProbeMode;
  text_context?: string;
  image_data_url?: string;
}

export interface ProbeResponse {
  ok: true;
  model: string;
  answer: string;
  latency_ms: number;
}

export interface ProbeError {
  ok: false;
  error: string;
}

/** Baseline multimodal OpenRouter slug (kept for A/B against newer models). */
export const DEFAULT_PROBE_MODEL = 'openai/gpt-4o-mini';

/**
 * Recent multimodal OpenRouter slugs for quick re-runs.
 * Prefer models created within the last few months (vision-capable).
 */
export const RECENT_PROBE_MODELS = [
  'google/gemini-3.7-flash',
  'openai/gpt-5.6-luna',
  'anthropic/claude-sonnet-4.6',
  'x-ai/grok-4.6',
] as const;

/** Primary comparison model when re-running against the gpt-4o-mini baseline. */
export const COMPARISON_PROBE_MODEL = RECENT_PROBE_MODELS[0];

export const REPRESENTATION_LABELS: Record<RepresentationId, string> = {
  tool_summary: 'Tool summary (text)',
  stats_table: 'Stats table (text)',
  csv_closes: 'Closes CSV (text)',
  overlay_normalized: 'Overlay chart',
  small_multiples: 'Small multiples',
  returns_heatmap: 'Returns heatmap',
  ranked_bars: 'Ranked bars',
  overlay_textless: 'Overlay (textless)',
  ranked_bars_textless: 'Ranked bars (textless)',
  overlay_color_keyed: 'Overlay + color key',
  ranked_bars_color_keyed: 'Ranked bars + color key',
};
