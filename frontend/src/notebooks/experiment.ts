/**
 * Shared experiment types for the text-vs-image notebook UI + API client.
 */

import type { ImageRepId } from './imageRepresentations.ts';
import type { TextRepId } from './textRepresentations.ts';

export type RepresentationId = TextRepId | ImageRepId;

export type ProbeMode = 'text' | 'image';

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

/** Default multimodal OpenRouter slug for the experiment. */
export const DEFAULT_PROBE_MODEL = 'openai/gpt-4o-mini';

export const REPRESENTATION_LABELS: Record<RepresentationId, string> = {
  tool_summary: 'Tool summary (text)',
  stats_table: 'Stats table (text)',
  csv_closes: 'Closes CSV (text)',
  overlay_normalized: 'Overlay chart',
  small_multiples: 'Small multiples',
  returns_heatmap: 'Returns heatmap',
  ranked_bars: 'Ranked bars',
};
