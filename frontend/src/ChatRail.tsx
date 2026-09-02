import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  List,
  ListItem,
  Skeleton,
  Text,
  VStack,
  useMediaQuery,
} from '@astryxdesign/core';
import { api, type TimelineRail as CompanionRailData } from './api';
import {
  ChatContextStrip,
  type FrameMetadata,
} from './ChatContextStrip';
import type { ChatAttachment } from './chatAttachments';
import './CompanionRail.css';

const CHAT_RAIL_LABELS = {
  ariaLabel: 'Chat rail',
  news: 'Related news',
  newsEmpty: 'No headlines yet',
  highlights: 'Session tape',
  highlightsEmpty: 'No tape yet',
} as const;

const EMPTY_RAIL: CompanionRailData = {
  tags: [],
  news: [],
  highlights: [],
  fetched_at: new Date(0).toISOString(),
};

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

function ChatRailSkeleton() {
  return (
    <VStack gap={5} className="companion-rail-body" aria-hidden="true">
      {[0, 1].map((index) => (
        <VStack key={index} gap={2}>
          <Skeleton width="40%" height="var(--spacing-4)" index={index} />
          <Skeleton width="100%" height="calc(var(--size-element-lg) * 4)" radius={3} index={index} />
        </VStack>
      ))}
    </VStack>
  );
}

function NewsAndTape({
  rail,
  loading,
}: {
  rail: CompanionRailData | null;
  loading: boolean;
}) {
  const navigate = useNavigate();
  const news = rail?.news ?? [];
  const highlights = rail?.highlights ?? [];
  const hasTickers = (rail?.tags.length ?? 0) > 0;

  if (!hasTickers && !loading) return null;

  if (loading && !rail) return <ChatRailSkeleton />;

  return (
    <VStack gap={5} className="companion-rail-body">
      <VStack gap={2} className="companion-rail-section">
        <List
          density="compact"
          hasDividers
          header={CHAT_RAIL_LABELS.news}
          className="companion-rail-news"
        >
          {news.length === 0 ? (
            <ListItem
              label={rail?.news_error ? 'Headlines unavailable' : CHAT_RAIL_LABELS.newsEmpty}
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
          header={CHAT_RAIL_LABELS.highlights}
          className="companion-rail-highlights"
        >
          {highlights.length === 0 ? (
            <ListItem
              label={rail?.highlights_error ? 'Tape unavailable' : CHAT_RAIL_LABELS.highlightsEmpty}
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
                  <Text className={`companion-rail-change ${changeClass(item.change_1d_pct)}`}>
                    {fmtPct(item.change_1d_pct)}
                  </Text>
                }
              />
            ))
          )}
        </List>
      </VStack>
    </VStack>
  );
}

/**
 * Desktop companion column inside chat chrome. Appears once the conversation
 * has attached sources (frames / linked tickers / portfolios). Hosts those
 * sources plus related news and session tape.
 */
export function ChatRail({
  chatId,
  frames,
  attachments = [],
  onAttachmentsChange,
  refreshKey = 0,
}: {
  chatId: string;
  frames: FrameMetadata[];
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (next: ChatAttachment[]) => void;
  /** Bump when research_ticker links a new symbol so the rail refreshes. */
  refreshKey?: number;
}): ReactNode {
  const isDesktop = useMediaQuery('(min-width: 56rem)');
  const [rail, setRail] = useState<CompanionRailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasStrip, setHasStrip] = useState(
    frames.length > 0 || attachments.length > 0,
  );

  useEffect(() => {
    setHasStrip((prev) => (
      frames.length > 0 || attachments.length > 0 ? true : prev
    ));
  }, [frames.length, attachments.length]);

  useEffect(() => {
    if (!isDesktop || !chatId) return;
    let cancelled = false;
    setLoading(true);
    void api.chatRail(chatId)
      .then((next) => {
        if (!cancelled) setRail(next);
      })
      .catch(() => {
        if (!cancelled) setRail({ ...EMPTY_RAIL, fetched_at: new Date().toISOString() });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, isDesktop, refreshKey]);

  if (!isDesktop) return null;

  const hasTickers = (rail?.tags.length ?? 0) > 0;
  const showRail = hasStrip || hasTickers || frames.length > 0 || attachments.length > 0;
  if (!showRail) return null;

  return (
    <VStack
      as="aside"
      gap={5}
      className="companion-rail chat-rail"
      aria-label={CHAT_RAIL_LABELS.ariaLabel}
    >
      <ChatContextStrip
        chatId={chatId}
        frames={frames}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        refreshKey={refreshKey}
        variant="rail"
        onPresenceChange={setHasStrip}
      />
      <NewsAndTape rail={rail} loading={loading} />
    </VStack>
  );
}
