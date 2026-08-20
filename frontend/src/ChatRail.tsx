import { useEffect, useState } from 'react';
import { useMediaQuery } from '@astryxdesign/core';
import { api, type TimelineRail as CompanionRailData } from './api';
import { CompanionRail } from './CompanionRail';

const CHAT_RAIL_LABELS = {
  ariaLabel: 'Chat rail',
  tags: 'In this chat',
  tagsEmpty: 'No tickers linked yet.',
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

/**
 * Desktop companion column for /chat — same shell as the timeline rail, but
 * tags / news / tape follow the tickers linked to this conversation.
 */
export function ChatRail({
  chatId,
  refreshKey = 0,
}: {
  chatId: string;
  /** Bump when research_ticker links a new symbol so the rail refreshes. */
  refreshKey?: number;
}) {
  const isDesktop = useMediaQuery('(min-width: 56rem)');
  const [rail, setRail] = useState<CompanionRailData | null>(null);
  const [loading, setLoading] = useState(false);

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

  const tags = (rail?.tags ?? []).map((tag) => ({
    ...tag,
    countNoun: 'mention',
  }));

  return (
    <CompanionRail
      labels={CHAT_RAIL_LABELS}
      tags={tags}
      news={rail?.news}
      highlights={rail?.highlights}
      newsError={rail?.news_error}
      highlightsError={rail?.highlights_error}
      loading={loading && !rail}
    />
  );
}
