import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Button,
  EmptyState,
  Heading,
  HStack,
  Markdown,
  Spinner,
  Text,
  Timestamp,
  VStack,
} from '@astryxdesign/core';
import { Newspaper, Sparkles } from 'lucide-react';
import './Timeline.css';
import { api, type TimelineAuthor, type TimelinePost } from './api';

function PostRow({ post }: { post: TimelinePost }) {
  const flags = [post.has_sql ? 'SQL' : null, post.has_chart ? 'Chart' : null].filter(Boolean).join(' · ');
  return (
    <VStack as="article" className="timeline-post" gap={2}>
      <Link
        to="/share/$shareId"
        params={{ shareId: post.share_id }}
        className="timeline-post-title"
      >
        <Heading level={2}>{post.title?.trim() || 'Shared chat'}</Heading>
      </Link>
      <HStack gap={2} vAlign="center" className="timeline-post-byline">
        <Link to="/u/$handle" params={{ handle: post.handle }} className="timeline-author-link">
          <Text type="supporting">@{post.handle}</Text>
        </Link>
        <Text type="supporting">·</Text>
        <Timestamp value={post.published_at / 1000} format="auto" isLive />
      </HStack>
      {post.excerpt ? (
        <VStack gap={0} className="timeline-excerpt">
          <Markdown>{post.excerpt}</Markdown>
        </VStack>
      ) : null}
      <HStack gap={3} vAlign="center" className="timeline-post-meta">
        {flags ? <Text type="supporting">{flags}</Text> : null}
        <Link
          to="/share/$shareId"
          params={{ shareId: post.share_id }}
          className="timeline-post-open"
        >
          <Text type="supporting">View full chat</Text>
        </Link>
      </HStack>
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
  const loadSeqRef = useRef(0);

  const load = useCallback(async (before?: number | null) => {
    const seq = ++loadSeqRef.current;
    const appending = before != null;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setMissing(false);
      setError(null);
    }
    try {
      const feed = await api.timeline({ handle, before: before ?? undefined });
      if (seq !== loadSeqRef.current) return;
      setProfile(feed.profile);
      setNextBefore(feed.next_before);
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

  const title = profile ? `@${profile.handle}` : 'Timeline';
  const subtitle = profile
    ? (profile.name && profile.name !== profile.handle ? profile.name : 'Public chats from this handle.')
    : 'Public chats people chose to share.';

  return (
    <VStack className="timeline" gap={5}>
      <VStack gap={1}>
        <Heading level={1}>{title}</Heading>
        <Text type="supporting">{subtitle}</Text>
      </VStack>

      {loading && (
        <HStack gap={3} vAlign="center" className="timeline-state">
          <Spinner size="md" />
          <Text type="supporting">Loading timeline…</Text>
        </HStack>
      )}

      {error && <Text className="timeline-err">{error}</Text>}

      {!loading && missing && (
        <EmptyState
          title="Profile not found"
          description="That handle isn't claimed."
          icon={<Newspaper size={24} />}
          actions={<Button variant="secondary" label="Back to timeline" onClick={() => { void navigate({ to: '/' }); }} />}
        />
      )}

      {!loading && !missing && items.length === 0 && (
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
        <VStack gap={0} className="timeline-feed">
          {items.map((post) => <PostRow key={post.share_id} post={post} />)}
        </VStack>
      )}

      {nextBefore != null && (
        <Button
          variant="ghost"
          label="Load older posts"
          isLoading={loadingMore}
          onClick={() => { void load(nextBefore); }}
        />
      )}
    </VStack>
  );
}
