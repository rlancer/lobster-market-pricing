import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Heading,
  HStack,
  List,
  ListItem,
  Skeleton,
  Text,
  VStack,
  useMediaQuery,
} from '@astryxdesign/core';
import { api, type TimelineRail as TimelineRailData } from './api';
import './Timeline.css';

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function fmtSpot(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function changeClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'up' : 'down';
}

function TimelineRailSkeleton() {
  return (
    <VStack gap={5} className="timeline-rail-body" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <VStack key={index} gap={2}>
          <Skeleton width="40%" height="var(--spacing-4)" index={index} />
          <Skeleton width="100%" height="calc(var(--size-element-lg) * 4)" radius={3} index={index} />
        </VStack>
      ))}
    </VStack>
  );
}

/**
 * Desktop-only companion column for the home timeline. Hidden below 56rem
 * (same breakpoint as Research's rail) until we have a mobile surface.
 */
export function TimelineRail() {
  const navigate = useNavigate();
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

  const tags = rail?.tags ?? [];
  const news = rail?.news ?? [];
  const highlights = rail?.highlights ?? [];

  return (
    <VStack
      as="aside"
      gap={5}
      className="timeline-rail"
      aria-label="Market rail"
    >
      {loading && !rail ? (
        <TimelineRailSkeleton />
      ) : (
        <VStack gap={5} className="timeline-rail-body">
          <VStack gap={2} className="timeline-rail-section">
            <Heading level={2} className="timeline-rail-heading">Tags</Heading>
            {tags.length === 0 ? (
              <Text type="supporting">No public tags yet.</Text>
            ) : (
              <HStack gap={2} wrap="wrap" className="timeline-rail-tags" aria-label="Trending tags">
                {tags.map((tag) => (
                  <Link
                    key={tag.ticker}
                    to="/research/$ticker"
                    params={{ ticker: tag.ticker }}
                    className="timeline-ticker"
                    aria-label={`${tag.ticker}, ${tag.posts} post${tag.posts === 1 ? '' : 's'}`}
                  >
                    {tag.ticker}
                  </Link>
                ))}
              </HStack>
            )}
          </VStack>

          <VStack gap={2} className="timeline-rail-section">
            <List
              density="compact"
              hasDividers
              header="Breaking news"
              className="timeline-rail-news"
            >
              {news.length === 0 ? (
                <ListItem
                  label={rail?.news_error ? 'Headlines unavailable' : 'No headlines yet'}
                  isDisabled
                />
              ) : (
                news.map((item) => (
                  <ListItem
                    key={item.link}
                    label={item.title}
                    description={item.snippet || undefined}
                    href={item.link}
                    target="_blank"
                  />
                ))
              )}
            </List>
          </VStack>

          <VStack gap={2} className="timeline-rail-section">
            <List
              density="compact"
              hasDividers
              header="Market highlights"
              className="timeline-rail-highlights"
            >
              {highlights.length === 0 ? (
                <ListItem
                  label={rail?.highlights_error ? 'Tape unavailable' : 'No tape yet'}
                  isDisabled
                />
              ) : (
                highlights.map((item) => (
                  <ListItem
                    key={item.ticker}
                    label={item.ticker}
                    description={`${item.name} · ${fmtSpot(item.spot)}`}
                    onClick={() => {
                      void navigate({ to: '/research/$ticker', params: { ticker: item.ticker } });
                    }}
                    endContent={
                      <Text
                        className={`timeline-rail-change ${changeClass(item.change_1d_pct)}`}
                      >
                        {fmtPct(item.change_1d_pct)}
                      </Text>
                    }
                  />
                ))
              )}
            </List>
          </VStack>
        </VStack>
      )}
    </VStack>
  );
}
