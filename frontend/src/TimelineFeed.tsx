import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  EmptyState,
  Heading,
  HStack,
  Skeleton,
  Text,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { BarChart3, ChevronDown, ChevronUp, Code2, Newspaper, Sparkles } from 'lucide-react';
import './Timeline.css';
import { TranscriptMessage } from './ChatTranscript';
import type { SharedChatMessage, TimelinePost } from './api';
import { UserAvatar } from './UserAvatar';

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
 * Clamp tall feed posts; expand/collapse in place so the full conversation
 * stays on the timeline (no /share route hop to keep reading).
 */
function FeedPreview({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const collapsed = !expanded && overflows;

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    if (expanded) {
      // Keep the control available while expanded so readers can collapse again.
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
        <VStack ref={bodyRef} gap={4} className="timeline-preview-body">
          {children}
        </VStack>
      </VStack>
      {overflows && (
        <Button
          variant="ghost"
          size="sm"
          className="timeline-continue"
          label={expanded ? 'Show less' : 'Show more'}
          endContent={
            expanded
              ? <ChevronUp size={14} aria-hidden="true" />
              : <ChevronDown size={14} aria-hidden="true" />
          }
          onClick={() => setExpanded((value) => !value)}
        />
      )}
    </VStack>
  );
}

export function TimelinePostRow({
  post,
  isAdmin,
  onUnpublish,
  showAuthor = true,
  titleLevel = 2,
}: {
  post: TimelinePost;
  isAdmin: boolean;
  onUnpublish: (post: TimelinePost) => Promise<void>;
  /** When false (profile page), skip the redundant author byline. */
  showAuthor?: boolean;
  /** Heading level for the post title (profile pages nest under “Public chats”). */
  titleLevel?: 2 | 3;
}) {
  const [unpublishing, setUnpublishing] = useState(false);
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
  const displayName = post.name?.trim() || post.handle;

  const unpublish = async () => {
    const who = post.is_bot ? `bot @${post.handle}` : (post.name?.trim() || `@${post.handle}`);
    if (!window.confirm(`Unpublish this chat by ${who} from the timeline? The share link will still work.`)) {
      return;
    }
    setUnpublishing(true);
    try {
      await onUnpublish(post);
    } finally {
      setUnpublishing(false);
    }
  };

  return (
    <VStack as="article" className="timeline-post" gap={4} aria-label={titleText}>
      {/* 1. Identity + time — scan layer */}
      <HStack gap={2} vAlign="center" className="timeline-post-byline">
        {showAuthor && (
          <>
            <Link to="/u/$handle" params={{ handle: post.handle }} className="timeline-author-link">
              <UserAvatar
                avatarUrl={post.avatar_url}
                className="timeline-author-avatar"
                alt=""
              />
              <HStack gap={1} vAlign="center" className="timeline-author-identity">
                <Text weight="semibold" maxLines={1}>{displayName}</Text>
                <Text type="supporting" maxLines={1}>@{post.handle}</Text>
              </HStack>
            </Link>
            {post.is_bot && (
              <Token label="bot" color="teal" />
            )}
            <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
          </>
        )}
        {!showAuthor && post.is_bot && (
          <>
            <Token label="bot" color="teal" />
            <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
          </>
        )}
        <Timestamp value={post.published_at / 1000} format="auto" isLive />
      </HStack>

      {/* 2. Headline + tags — what this post is about */}
      {(showTitle || tickers.length > 0) && (
        <VStack gap={2} className="timeline-post-head">
          {showTitle && (
            <Heading level={titleLevel} className="timeline-post-title">
              {titleText}
            </Heading>
          )}
          {tickers.length > 0 && (
            <HStack gap={2} vAlign="center" className="timeline-tickers" aria-label="Tags">
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
        </VStack>
      )}

      {/* 3. Full conversation — primary content, expand in place */}
      {messages.length > 0 && (
        <FeedPreview>
          <VStack gap={4} className="timeline-msgs" aria-label="Conversation">
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

      {/* 4. Supporting meta — technical flags + moderation */}
      {(post.has_sql || post.has_chart || post.model || isAdmin) && (
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
          {isAdmin && (
            <HStack gap={2} vAlign="center" className="timeline-post-actions">
              <Button
                variant="destructive"
                size="sm"
                label="Unpublish"
                isLoading={unpublishing}
                onClick={() => { void unpublish(); }}
              />
            </HStack>
          )}
        </HStack>
      )}
    </VStack>
  );
}

export function TimelineFeedSkeleton() {
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

export function TimelineEmpty({
  handle,
  onAsk,
}: {
  handle?: string;
  onAsk: () => void;
}) {
  return (
    <EmptyState
      title={handle ? 'No public chats yet' : 'The timeline is empty'}
      description={handle
        ? 'This handle has not posted a chat to the public timeline.'
        : 'Share a chat and turn on “Post to public timeline” to appear here.'}
      icon={<Newspaper size={24} />}
      headingLevel={2}
      actions={<Button variant="primary" label="Ask the Lobster" icon={<Sparkles size={16} />} onClick={onAsk} />}
    />
  );
}
