import { createContext, useContext, useLayoutEffect } from 'react';
import type { PageMeta } from './pageMeta';

export type PageMetaOverride = Partial<PageMeta> | null;

export const SetPageMetaOverride = createContext<(value: PageMetaOverride) => void>(() => {});

/** Merge loaded-content fields into the current route's tags. Pass null to revert. */
export function usePageMeta(override: Partial<PageMeta> | null | undefined) {
  const setOverride = useContext(SetPageMetaOverride);
  const title = override?.title;
  const description = override?.description;
  const ogDescription = override?.ogDescription;

  useLayoutEffect(() => {
    if (!title && !description && !ogDescription) return;
    setOverride({
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(ogDescription ? { ogDescription } : {}),
    });
    return () => setOverride(null);
  }, [setOverride, title, description, ogDescription]);
}
