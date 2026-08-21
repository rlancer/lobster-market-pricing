import { useEffect, useState } from 'react';
import { useMediaQuery } from '@astryxdesign/core';
import { api, type TimelineRail as TimelineRailData } from './api';
import { CompanionRail } from './CompanionRail';

const TIMELINE_RAIL_LABELS = {
  ariaLabel: 'Market rail',
  tags: 'Tags',
  tagsEmpty: 'No public tags yet.',
  news: 'Breaking news',
  newsEmpty: 'No headlines yet',
  highlights: 'Market highlights',
  highlightsEmpty: 'No tape yet',
} as const;

/**
 * Desktop-only companion column for the home timeline and /u/$handle
 * profiles. Hidden below 56rem (same breakpoint as Research's rail) until
 * we have a mobile surface.
 */
export function TimelineRail() {
  const isDesktop = useMediaQuery('(min-width: 56rem)');
  const [rail, setRail] = useState<TimelineRailData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    setLoading(true);
    void api.timelineRail()
      .then((next) => {
        if (!cancelled) setRail(next);
      })
      .catch(() => {
        if (!cancelled) {
          setRail({
            tags: [],
            news: [],
            highlights: [],
            fetched_at: new Date().toISOString(),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  if (!isDesktop) return null;

  return (
    <CompanionRail
      labels={TIMELINE_RAIL_LABELS}
      tags={rail?.tags}
      news={rail?.news}
      highlights={rail?.highlights}
      newsError={rail?.news_error}
      highlightsError={rail?.highlights_error}
      loading={loading && !rail}
    />
  );
}
