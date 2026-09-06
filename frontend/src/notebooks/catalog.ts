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
      'Can a multimodal model read synthetic equity panels better from AI-style text, labeled chart images, or textless charts with a markdown color key?',
    status: 'ready',
  },
  {
    slug: 'desk-approaches',
    title: 'Analyst desk vs sessions',
    subtitle:
      'As-of snapshot bench: solo analyst vs production desk role-play vs a new session per specialist, graded on held-out 5d/20d direction.',
    status: 'draft',
  },
];

/** @deprecated Use EXPERIMENTS */
export const NOTEBOOKS = EXPERIMENTS;

export function experimentBySlug(slug: string): ExperimentMeta | undefined {
  return EXPERIMENTS.find((e) => e.slug === slug);
}

/** @deprecated Use experimentBySlug */
export const notebookBySlug = experimentBySlug;
