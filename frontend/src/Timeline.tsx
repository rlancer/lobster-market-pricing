import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Button,
  ChatComposer,
  ChatSendButton,
  EmptyState,
  Heading,
  HStack,
  Skeleton,
  Text,
  Timestamp,
  VStack,
} from '@astryxdesign/core';
import { ArrowRight, BarChart3, Code2, Newspaper, Sparkles } from 'lucide-react';
import './Timeline.css';
import { TranscriptMessage } from './ChatTranscript';
import { api, type SharedChatMessage, type TimelineAuthor, type TimelinePost } from './api';
import { stashPendingPrompt, startNewChatId } from './chatSession';

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

/** Leaf model id for supporting meta — drop provider prefix and dated build tags. */
function shortModel(model: string): string {
  const leaf = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return leaf.replace(/-\d{4}(-\d{2}){0,2}$/, '') || leaf;
}

function titlesMatch(title: string, userContent: string | undefined): boolean {
  if (!userContent) return false;
  return title.trim().toLowerCase() === userContent.trim().toLowerCase();
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

/** Clamp tall feed previews; expand in place so the first answer stays on the timeline. */
function FeedPreview({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const collapsed = !expanded && overflows;

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    if (expanded) {
      setOverflows(false);
      return;
    }
    const measure = () => {
      // Compare natural content height to the CSS clamp cap (12 × --size-element-lg).
      const lg = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--size-element-lg'),
      ) || 36;
      setOverflows(node.scrollHeight > lg * 12 + 4);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children, expanded]);

  return (
    <VStack gap={2} className="timeline-preview-wrap">
      <VStack
        gap={0}
        className={collapsed ? 'timeline-preview is-clamped' : 'timeline-preview'}
        aria-expanded={overflows ? expanded : undefined}
      >
        <VStack ref={bodyRef} gap={3} className="timeline-preview-body">
          {children}
        </VStack>
      </VStack>
      {collapsed && (
        <Button
          variant="ghost"
          size="sm"
          className="timeline-continue"
          label="Continue reading"
          endContent={<ArrowRight size={14} aria-hidden="true" />}
          onClick={() => setExpanded(true)}
        />
      )}
    </VStack>
  );
}

function PostRow({ post }: { post: TimelinePost }) {
  const messages: SharedChatMessage[] = post.messages?.length
    ? post.messages
    : post.excerpt
      ? [{ role: 'assistant', content: post.excerpt }]
      : [];
  const titleText = post.title?.trim() || 'Shared chat';
  const userMessage = messages.find((message) => message.role === 'user');
  const showTitle = !titlesMatch(titleText, userMessage?.content);
  const tickers = (post.tickers ?? [])
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);

  return (
    <VStack as="article" className="timeline-post" gap={3} aria-label={titleText}>
      <VStack gap={1} className="timeline-post-head">
        <HStack gap={2} vAlign="center" className="timeline-post-byline">
          <Link to="/u/$handle" params={{ handle: post.handle }} className="timeline-author-link">
            <Text weight="semibold" maxLines={1}>@{post.handle}</Text>
          </Link>
          <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
          <Timestamp value={post.published_at / 1000} format="auto" isLive />
        </HStack>
        {tickers.length > 0 && (
          <HStack gap={2} vAlign="center" className="timeline-tickers" aria-label="Tickers">
            {tickers.map((ticker) => (
              <Link
                key={ticker}
                to="/research/$ticker"
                params={{ ticker }}
                className="timeline-ticker"
              >
                {ticker}
              </Link>
            ))}
          </HStack>
        )}
        {showTitle && (
          <Link
            to="/share/$shareId"
            params={{ shareId: post.share_id }}
            className="timeline-post-title"
          >
            <Heading level={2}>{titleText}</Heading>
          </Link>
        )}
      </VStack>

      {messages.length > 0 && (
        <FeedPreview>
          <VStack gap={3} className="timeline-msgs" aria-label="Chat preview">
            {messages.map((message, index) => (
              <TranscriptMessage
                key={`${post.share_id}-${index}`}
                message={message}
                openInData
                hydrateResult={false}
                collapseSql
              />
            ))}
          </VStack>
        </FeedPreview>
      )}

      <HStack gap={3} vAlign="center" className="timeline-post-meta">
        {(post.has_sql || post.has_chart || post.model) && (
          <HStack gap={2} vAlign="center" className="timeline-post-flags" aria-label="Post details">
            {post.has_sql && (
              <HStack gap={1} vAlign="center" className="timeline-flag">
                <Code2 size={14} aria-hidden="true" />
                <Text type="supporting">SQL</Text>
              </HStack>
            )}
            {post.has_chart && (
              <HStack gap={1} vAlign="center" className="timeline-flag">
                <BarChart3 size={14} aria-hidden="true" />
                <Text type="supporting">Chart</Text>
              </HStack>
            )}
            {post.model && (
              <>
                {(post.has_sql || post.has_chart) && (
                  <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
                )}
                <Text type="supporting" className="timeline-model" maxLines={1}>
                  {shortModel(post.model)}
                </Text>
              </>
            )}
          </HStack>
        )}
        <Link
          to="/share/$shareId"
          params={{ shareId: post.share_id }}
          className="timeline-post-open"
        >
          <Text weight="semibold">View full chat</Text>
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </HStack>
    </VStack>
  );
}

function FeedSkeleton() {
  return (
    <VStack gap={0} className="timeline-feed" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <VStack key={index} gap={3} className="timeline-post timeline-post-skeleton" paddingBlock={6}>
          <Skeleton width="28%" height="var(--spacing-4)" index={index} />
          <Skeleton width="92%" height="var(--spacing-4)" index={index} />
          <Skeleton width="100%" height="calc(var(--size-element-lg) * 4)" radius={3} index={index} />
        </VStack>
      ))}
    </VStack>
  );
}

export default function TimelinePage() {
  const navigate = useNavigate();
  const { handle: handleParam } = useParams({ strict: false }) as { handle?: string };
  const handle = handleParam?.trim().toLowerCase() || undefined;
  const [items, setItems] = useState<TimelinePost[]>([]);
  const [profile, setProfile] = useState<TimelineAuthor | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const loadSeqRef = useRef(0);

  const load = useCallback(async (before?: number | null) => {
    const seq = ++loadSeqRef.current;
    const appending = before != null;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setMissing(false);
      setError(null);
      setProfile(null);
    }
    try {
      const feed = await api.timeline({ handle, before: before ?? undefined });
      if (seq !== loadSeqRef.current) return;
      setNextBefore(feed.next_before);
      if (!appending) setProfile(feed.profile);
      setItems((prev) => appending ? [...prev, ...feed.items] : feed.items);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (handle && /API 404|API 400/.test(message)) {
        setMissing(true);
        setItems([]);
        setProfile(null);
      } else {
        setError('Could not load the timeline.');
      }
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [handle]);

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

  return (
    <VStack className="timeline" gap={0}>
      <TimelineAskComposer
        value={composer}
        onChange={setComposer}
        onSubmit={launchChat}
      />

      <VStack gap={5} className="timeline-body" paddingBlock={5}>
        {handle && !loading && !missing && profile && (
          <HStack as="header" gap={4} vAlign="center" className="timeline-profile">
            <VStack gap={0} className="timeline-profile-copy">
              <Heading level={1}>@{profile.handle}</Heading>
            </VStack>
            <Button
              variant="secondary"
              size="sm"
              label="All posts"
              onClick={() => { void navigate({ to: '/' }); }}
            />
          </HStack>
        )}

        {loading && <FeedSkeleton />}

        {error && (
          <VStack gap={3} className="timeline-state">
            <Text className="timeline-err">{error}</Text>
            <Button variant="secondary" size="sm" label="Try again" onClick={() => { void load(); }} />
          </VStack>
        )}

        {!loading && missing && (
          <EmptyState
            title="Profile not found"
            description="That handle isn't claimed."
            icon={<Newspaper size={24} />}
            actions={<Button variant="secondary" label="Back to timeline" onClick={() => { void navigate({ to: '/' }); }} />}
          />
        )}

        {!loading && !missing && !error && items.length === 0 && (
          <EmptyState
            title={handle ? 'No public posts yet' : 'The timeline is empty'}
            description={handle
              ? 'This handle has not posted a chat to the public timeline.'
              : 'Share a chat and turn on “Post to public timeline” to appear here.'}
            icon={<Newspaper size={24} />}
            headingLevel={2}
            actions={<Button variant="primary" label="Ask the Lobster" icon={<Sparkles size={16} />} onClick={() => { void navigate({ to: '/chat' }); }} />}
          />
        )}

        {!loading && items.length > 0 && (
          <VStack gap={0} className="timeline-feed" aria-busy={loadingMore || undefined}>
            {items.map((post) => <PostRow key={post.share_id} post={post} />)}
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
