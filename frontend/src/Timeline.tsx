import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  ChatComposer,
  ChatSendButton,
  HStack,
  Text,
  VStack,
  useAppShellMobile,
} from '@astryxdesign/core';
import './Timeline.css';
import { api, type TimelinePost } from './api';
import { stashPendingPrompt, startNewChatId } from './chatSession';
import { useIsAdmin } from './useAdmin';
import { SessionCard } from './SessionCard';
import { TimelineEmpty, TimelineFeedSkeleton, TimelinePostRow } from './TimelineFeed';
import { TimelineRail } from './TimelineRail';

/**
 * Sticky ask box at the top of the desktop feed. On mobile the bottom nav owns
 * New chat + ticker search, so this composer is desktop-only.
 */
function TimelineAskComposer({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <VStack
      as="section"
      gap={0}
      className="timeline-composer"
      aria-label="Ask the Lobster"
    >
      <ChatComposer
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Ask about liquidity, volatility, or a ticker…"
        density="balanced"
        sendButton={<ChatSendButton />}
      />
    </VStack>
  );
}

/** Home feed of opted-in public chats. Per-handle profiles live at /u/$handle. */
export default function TimelinePage() {
  const navigate = useNavigate();
  const { isMobile } = useAppShellMobile();
  const { isAdmin } = useIsAdmin();
  const [items, setItems] = useState<TimelinePost[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const load = useCallback(async (before?: number | null) => {
    const seq = ++loadSeqRef.current;
    const appending = before != null;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setError(null);
      setActionError(null);
    }
    try {
      const feed = await api.timeline({ before: before ?? undefined });
      if (seq !== loadSeqRef.current) return;
      setNextBefore(feed.next_before);
      setItems((prev) => appending ? [...prev, ...feed.items] : feed.items);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setError('Could not load the Floor.');
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const launchChat = useCallback((raw: string) => {
    const question = raw.trim();
    if (!question) return;
    stashPendingPrompt(question);
    startNewChatId();
    setComposer('');
    void navigate({ to: '/chat' });
  }, [navigate]);

  const unpublishPost = useCallback(async (post: TimelinePost) => {
    setActionError(null);
    // Drop from the feed immediately; restore if the Worker rejects.
    setItems((prev) => prev.filter((row) => row.share_id !== post.share_id));
    try {
      await api.unpublishTimeline(post.share_id);
    } catch (err) {
      setItems((prev) => {
        if (prev.some((row) => row.share_id === post.share_id)) return prev;
        return [...prev, post].sort(
          (a, b) => b.published_at - a.published_at || (a.share_id < b.share_id ? 1 : -1),
        );
      });
      setActionError(err instanceof Error ? err.message : 'Could not unpublish.');
      throw err;
    }
  }, []);

  return (
    <VStack className="timeline content-column" gap={0}>
      <section className="timeline-columns">
        <VStack className="timeline-main" gap={0}>
          {!isMobile ? (
            <TimelineAskComposer
              value={composer}
              onChange={setComposer}
              onSubmit={launchChat}
            />
          ) : null}

          <VStack gap={5} className="timeline-body" paddingBlock={5}>
            <SessionCard onAsk={launchChat} />

            {loading && <TimelineFeedSkeleton />}

            {(error || actionError) && (
              <VStack gap={3} className="timeline-state">
                <Text className="timeline-err">{error ?? actionError}</Text>
                {error && (
                  <Button variant="secondary" size="sm" label="Try again" onClick={() => { void load(); }} />
                )}
              </VStack>
            )}

            {!loading && !error && items.length === 0 && (
              <TimelineEmpty onAsk={() => { void navigate({ to: '/chat' }); }} />
            )}

            {!loading && items.length > 0 && (
              <VStack gap={0} className="timeline-feed" aria-busy={loadingMore || undefined}>
                {items.map((post) => (
                  <TimelinePostRow
                    key={post.share_id}
                    post={post}
                    isAdmin={isAdmin}
                    onUnpublish={unpublishPost}
                  />
                ))}
              </VStack>
            )}

            {nextBefore != null && (
              <HStack hAlign="center" className="timeline-more">
                <Button
                  variant="secondary"
                  label="Load older posts"
                  isLoading={loadingMore}
                  onClick={() => { void load(nextBefore); }}
                />
              </HStack>
            )}
          </VStack>
        </VStack>

        <TimelineRail />
      </section>
    </VStack>
  );
}
