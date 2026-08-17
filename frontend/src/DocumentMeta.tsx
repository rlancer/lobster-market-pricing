import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { applyPageMeta, pageMetaForUrl } from './pageMeta';
import { SetPageMetaOverride, type PageMetaOverride } from './usePageMeta';

/**
 * Keeps `<title>`, description, canonical, and Open Graph tags in sync with
 * the current route. Child routes can pass loaded-content overrides
 * (research name, share title) via `usePageMeta`.
 */
export function DocumentMeta({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [override, setOverride] = useState<PageMetaOverride>(null);
  const pathKey = `${location.pathname}${location.searchStr}`;

  useLayoutEffect(() => {
    const base = pageMetaForUrl(location.pathname, location.searchStr);
    applyPageMeta({ ...base, ...override }, window.location.origin);
  }, [pathKey, location.pathname, location.searchStr, override]);

  return (
    <SetPageMetaOverride.Provider value={setOverride}>
      {children}
    </SetPageMetaOverride.Provider>
  );
}
