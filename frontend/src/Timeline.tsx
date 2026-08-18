import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  ChatComposer,
  ChatSendButton,
  HStack,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Sparkles } from 'lucide-react';
import './Timeline.css';
import { api, type TimelinePost } from './api';
import { stashPendingPrompt, startNewChatId } from './chatSession';
import { useIsAdmin } from './useAdmin';
import { TimelineEmpty, TimelineFeedSkeleton, TimelinePostRow } from './TimelineFeed';

/** Nearest ancestor that scrolls — AppShell content pane, else the viewport. */
function nearestScrollRoot(node: HTMLElement | null): Element | null {
  let current = node?.parentElement ?? null;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Full ask box at the top of the feed. Once the user scrolls past it, collapse
 * to a slim sticky “Ask the Lobster” chip so the composer stops eating mobile
 * viewport. Tapping the chip expands it again; scrolling back to the top
 * restores the full composer automatically.
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
  const sentinelRef = useRef<HTMLElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const [pastTop, setPastTop] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const hasDraft = Boolean(value.trim());
  const collapsed = pastTop && !expanded && !hasDraft;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const root = nearestScrollRoot(sentinel);
    const observer = new IntersectionObserver(
      ([entry]) => {
        const past = !entry.isIntersecting;
        setPastTop(past);
        if (!past) setExpanded(false);
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (collapsed) return;
    if (!pastTop && !expanded) return;
    const region = regionRef.current;
    if (!region) return;
    const input = region.querySelector<HTMLElement>('textarea, [role="textbox"]');
    input?.focus();
  }, [collapsed, pastTop, expanded]);

  return (
    <>
      <VStack
        ref={sentinelRef}
        className="timeline-composer-sentinel"
        aria-hidden="true"
      />
      <VStack
        ref={regionRef}
        as="section"
        gap={0}
        className={
          collapsed
            ? 'timeline-composer is-collapsed'
            : pastTop
              ? 'timeline-composer is-sticky-open'
              : 'timeline-composer'
        }
        aria-label="Ask the Lobster"
        data-collapsed={collapsed ? 'true' : undefined}
      >
        {collapsed ? (
          <Button
            variant="secondary"
            size="sm"
            className="timeline-ask-chip"
            label="Ask the Lobster"
            icon={<Sparkles size={16} />}
            onClick={() => setExpanded(true)}
          />
        ) : (
          <ChatComposer
            value={value}
            onChange={onChange}
            onSubmit={(raw) => {
              setExpanded(false);
              onSubmit(raw);
            }}
            placeholder="Ask about liquidity, volatility, or a ticker…"
            density={pastTop ? 'compact' : 'balanced'}
            sendButton={<ChatSendButton />}
          />
        )}
      </VStack>
    </>
  );
}

/** Home feed of opted-in public chats. Per-handle profiles live at /u/$handle. */
export default function TimelinePage() {
  const navigate = useNavigate();
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
      setError('Could not load the timeline.');
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
      <TimelineAskComposer
        value={composer}
        onChange={setComposer}
        onSubmit={launchChat}
      />

      <VStack gap={5} className="timeline-body" paddingBlock={5}>
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
  );
}
