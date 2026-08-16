import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Avatar,
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

/** Leaf model id for supporting meta — drop provider prefix and dated build tags. */
function shortModel(model: string): string {
  const leaf = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return leaf.replace(/-\d{4}(-\d{2}){0,2}$/, '') || leaf;
}

function titlesMatch(title: string, userContent: string | undefined): boolean {
  if (!userContent) return false;
  return title.trim().toLowerCase() === userContent.trim().toLowerCase();
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
  const authorName = post.name?.trim() || post.handle;

  return (
    <VStack as="article" className="timeline-post" gap={3} aria-label={titleText}>
      <HStack gap={3} vAlign="start" className="timeline-post-head">
        <Link
          to="/u/$handle"
          params={{ handle: post.handle }}
          className="timeline-avatar-link"
          aria-label={`@${post.handle}`}
        >
          <Avatar name={authorName} size="md" tooltip={false} />
        </Link>
        <VStack gap={1} className="timeline-post-identity">
          <HStack gap={2} vAlign="center" className="timeline-post-byline">
            <Link to="/u/$handle" params={{ handle: post.handle }} className="timeline-author-link">
              <Text weight="semibold" maxLines={1}>{authorName}</Text>
            </Link>
            <Link to="/u/$handle" params={{ handle: post.handle }} className="timeline-author-link">
              <Text type="supporting" maxLines={1}>@{post.handle}</Text>
            </Link>
            <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
            <Timestamp value={post.published_at / 1000} format="auto" isLive />
          </HStack>
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
      </HStack>

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
          <HStack gap={3} vAlign="center">
            <Skeleton width="var(--size-element-lg)" height="var(--size-element-lg)" radius="rounded" index={index} />
            <VStack gap={2} className="timeline-skeleton-copy">
              <Skeleton width="40%" height="var(--spacing-4)" index={index} />
              <Skeleton width="28%" height="var(--spacing-3)" index={index} />
            </VStack>
          </HStack>
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

  const profileName = profile?.name?.trim() || profile?.handle || handle;

  return (
    <VStack className="timeline" gap={0}>
      <VStack as="section" gap={0} paddingBlock={4} className="timeline-composer" aria-label="Ask the Lobster">
        <ChatComposer
          value={composer}
          onChange={setComposer}
          onSubmit={launchChat}
          placeholder="Ask about liquidity, volatility, or a ticker…"
          sendButton={<ChatSendButton />}
        />
      </VStack>

      <VStack gap={5} className="timeline-body" paddingBlock={5}>
        {handle && !loading && !missing && profile && (
          <HStack as="header" gap={4} vAlign="center" className="timeline-profile">
            <Avatar name={profileName || handle} size="lg" tooltip={false} />
            <VStack gap={0} className="timeline-profile-copy">
              <Heading level={1}>{profileName}</Heading>
              <Text type="supporting">@{profile.handle}</Text>
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
