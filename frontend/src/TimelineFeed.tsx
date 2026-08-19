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
import { ArrowRight, BarChart3, Code2, Newspaper, Sparkles } from 'lucide-react';
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
  const hasUserTurn = messages.some((message) => message.role === 'user');
  /**
   * Right-side speaker chrome: photo + (on the home feed) name/@handle.
   * Profile pages already show identity in the header, so the aside is face-only.
   */
  const authorAside = (
    <VStack gap={1} className="timeline-user-aside" hAlign="center">
      {showAuthor ? (
        <Link
          to="/u/$handle"
          params={{ handle: post.handle }}
          className="timeline-msg-avatar-link"
          aria-label={`${displayName} (@${post.handle})`}
        >
          <UserAvatar
            avatarUrl={post.avatar_url}
            className="timeline-author-avatar"
            alt=""
          />
        </Link>
      ) : (
        <UserAvatar
          avatarUrl={post.avatar_url}
          className="timeline-author-avatar"
          alt=""
        />
      )}
      {showAuthor && (
        <Link
          to="/u/$handle"
          params={{ handle: post.handle }}
          className="timeline-user-aside-copy"
        >
          <Text weight="semibold" maxLines={1}>{displayName}</Text>
          <Text type="supporting" maxLines={1}>@{post.handle}</Text>
        </Link>
      )}
    </VStack>
  );

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
    <VStack as="article" className="timeline-post" gap={3} aria-label={titleText}>
      <VStack gap={1} className="timeline-post-head">
        <HStack gap={2} vAlign="center" className="timeline-post-byline">
          {showAuthor && !hasUserTurn && (
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
          {showAuthor && hasUserTurn && post.is_bot && (
            <>
              <Token label="bot" color="teal" />
              <Text type="supporting" className="timeline-byline-sep" aria-hidden="true">·</Text>
            </>
          )}
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
            <Heading level={titleLevel}>{titleText}</Heading>
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
                userAside={authorAside}
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
        <HStack gap={2} vAlign="center" className="timeline-post-actions">
          {isAdmin && (
            <Button
              variant="destructive"
              size="sm"
              label="Unpublish"
              isLoading={unpublishing}
              onClick={() => { void unpublish(); }}
            />
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
      </HStack>
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
