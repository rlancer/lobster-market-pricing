/** Registry of admin notebooks. */

export interface NotebookMeta {
  slug: string;
  title: string;
  subtitle: string;
  status: 'ready' | 'draft';
}

export const NOTEBOOKS: NotebookMeta[] = [
  {
    slug: 'text-vs-image',
    title: 'Text vs image context',
    subtitle:
      'Can a multimodal model read synthetic equity panels better from Copilot-style text summaries or from chart images?',
    status: 'ready',
  },
];

export function notebookBySlug(slug: string): NotebookMeta | undefined {
  return NOTEBOOKS.find((n) => n.slug === slug);
}
