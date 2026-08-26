/** Registry of public experiments (notebook-style studies). */

export interface ExperimentMeta {
  slug: string;
  title: string;
  subtitle: string;
  status: 'ready' | 'draft';
}

export const EXPERIMENTS: ExperimentMeta[] = [
  {
    slug: 'text-vs-image',
    title: 'Text vs image context',
    subtitle:
      'Can a multimodal model read a dense synthetic equity panel better from AI-style text, the same text rasterized as images, labeled charts, or textless charts with a markdown color key?',
    status: 'ready',
  },
];

/** @deprecated Use EXPERIMENTS */
export const NOTEBOOKS = EXPERIMENTS;

export function experimentBySlug(slug: string): ExperimentMeta | undefined {
  return EXPERIMENTS.find((e) => e.slug === slug);
}

/** @deprecated Use experimentBySlug */
export const notebookBySlug = experimentBySlug;
