import { Link, useNavigate } from '@tanstack/react-router';
import {
  Heading,
  HStack,
  List,
  ListItem,
  Skeleton,
  Text,
  VStack,
} from '@astryxdesign/core';
import type {
  TimelineRailHighlight,
  TimelineRailNewsItem,
  TimelineRailTag,
} from './api';
import './CompanionRail.css';

export interface CompanionRailTag extends TimelineRailTag {
  /** Override the default “N posts” aria count label (e.g. “mentions”). */
  countNoun?: string;
}

export interface CompanionRailLabels {
  ariaLabel: string;
  tags: string;
  tagsEmpty: string;
  news: string;
  newsEmpty: string;
  highlights: string;
  highlightsEmpty: string;
}

export interface CompanionRailProps {
  labels: CompanionRailLabels;
  tags?: CompanionRailTag[];
  news?: TimelineRailNewsItem[];
  highlights?: TimelineRailHighlight[];
  newsError?: string;
  highlightsError?: string;
  loading?: boolean;
}

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

function CompanionRailSkeleton() {
  return (
    <VStack gap={5} className="companion-rail-body" aria-hidden="true">
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
 * Presentational desktop companion column — tags, headlines, and a tape.
 * Timeline and Chat supply their own data + copy; this owns layout only.
 */
export function CompanionRail({
  labels,
  tags = [],
  news = [],
  highlights = [],
  newsError,
  highlightsError,
  loading = false,
}: CompanionRailProps) {
  const navigate = useNavigate();

  return (
    <VStack
      as="aside"
      gap={5}
      className="companion-rail"
      aria-label={labels.ariaLabel}
    >
      {loading ? (
        <CompanionRailSkeleton />
      ) : (
        <VStack gap={5} className="companion-rail-body">
          <VStack gap={2} className="companion-rail-section">
            <Heading level={2} className="companion-rail-heading">{labels.tags}</Heading>
            {tags.length === 0 ? (
              <Text type="supporting">{labels.tagsEmpty}</Text>
            ) : (
              <HStack gap={2} wrap="wrap" className="companion-rail-tags" aria-label={labels.tags}>
                {tags.map((tag) => {
                  const noun = tag.countNoun ?? 'post';
                  const count = tag.posts;
                  return (
                    <Link
                      key={tag.ticker}
                      to="/research/$ticker"
                      params={{ ticker: tag.ticker }}
                      className="companion-rail-ticker"
                      aria-label={`${tag.ticker}, ${count} ${noun}${count === 1 ? '' : 's'}`}
                    >
                      {tag.ticker}
                    </Link>
                  );
                })}
              </HStack>
            )}
          </VStack>

          <VStack gap={2} className="companion-rail-section">
            <List
              density="compact"
              hasDividers
              header={labels.news}
              className="companion-rail-news"
            >
              {news.length === 0 ? (
                <ListItem
                  label={newsError ? 'Headlines unavailable' : labels.newsEmpty}
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

          <VStack gap={2} className="companion-rail-section">
            <List
              density="compact"
              hasDividers
              header={labels.highlights}
              className="companion-rail-highlights"
            >
              {highlights.length === 0 ? (
                <ListItem
                  label={highlightsError ? 'Tape unavailable' : labels.highlightsEmpty}
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
                        className={`companion-rail-change ${changeClass(item.change_1d_pct)}`}
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
