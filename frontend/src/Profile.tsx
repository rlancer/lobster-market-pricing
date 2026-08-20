import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
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
import { Newspaper } from 'lucide-react';
import './Timeline.css';
import './Profile.css';
import { api, type TimelineAuthor, type TimelinePost } from './api';
import { UserAvatar } from './UserAvatar';
import { useIsAdmin } from './useAdmin';
import { TimelineEmpty, TimelineFeedSkeleton, TimelinePostRow } from './TimelineFeed';

function ProfileHeaderSkeleton() {
  return (
    <HStack as="header" gap={4} vAlign="start" className="profile-header" aria-hidden="true">
      <Skeleton width="var(--size-element-xl, 56px)" height="var(--size-element-xl, 56px)" radius="rounded" index={0} />
      <VStack gap={3} className="profile-header-copy">
        <VStack gap={1}>
          <Skeleton width="42%" height="var(--spacing-6)" index={0} />
          <Skeleton width="56%" height="var(--spacing-4)" index={0} />
        </VStack>
        <VStack gap={1}>
          <Skeleton width="38%" height="var(--spacing-4)" index={0} />
          <Skeleton width="72%" height="var(--spacing-4)" index={0} />
        </VStack>
      </VStack>
    </HStack>
  );
}

function ProfileMetaSep() {
  return (
    <Text type="supporting" className="profile-meta-sep" aria-hidden="true">·</Text>
  );
}

function ProfileHeader({
  profile,
  onBack,
}: {
  profile: TimelineAuthor;
  onBack: () => void;
}) {
  const joinedAt = typeof profile.created_at === 'number' && profile.created_at > 0
    ? profile.created_at
    : null;
  const persona = profile.is_bot ? profile.persona?.trim() || null : null;
  const bio = profile.is_bot ? profile.bio?.trim() || null : null;

  return (
    <HStack as="header" gap={4} vAlign="start" className="profile-header">
      <UserAvatar avatarUrl={profile.avatar_url} className="profile-avatar" alt="" />
      <VStack gap={3} className="profile-header-copy">
        <VStack gap={1} className="profile-identity">
          <Heading level={1} maxLines={2}>{profile.name}</Heading>
          <HStack gap={2} vAlign="center" wrap="wrap" className="profile-meta">
            <Text type="supporting" weight="semibold">@{profile.handle}</Text>
            {profile.is_bot && <Token label="bot" color="teal" size="sm" />}
            {joinedAt != null && (
              <>
                <ProfileMetaSep />
                <HStack gap={1} vAlign="center" className="profile-joined">
                  <Text type="supporting">Joined</Text>
                  <Timestamp value={joinedAt / 1000} format="date_long" />
                </HStack>
              </>
            )}
          </HStack>
        </VStack>

        {(persona || bio) && (
          <VStack gap={1} className="profile-about">
            {persona && (
              <Text type="body" weight="semibold" className="profile-persona">
                {persona}
              </Text>
            )}
            {bio && (
              <Text type="supporting" className="profile-bio">
                {bio}
              </Text>
            )}
          </VStack>
        )}
      </VStack>
      <Button
        variant="secondary"
        size="sm"
        className="profile-back"
        label="All posts"
        onClick={onBack}
      />
    </HStack>
  );
}

/**
 * Public user / bot details at /u/$handle — profile identity plus chats they
 * opted onto the public timeline (bots appear via bot_handle shares).
 */
export default function ProfilePage() {
  const navigate = useNavigate();
  const { isAdmin } = useIsAdmin();
  const { handle: handleParam } = useParams({ strict: false }) as { handle?: string };
  const handle = handleParam?.trim().toLowerCase() || '';
  const [items, setItems] = useState<TimelinePost[]>([]);
  const [profile, setProfile] = useState<TimelineAuthor | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const load = useCallback(async (before?: number | null) => {
    if (!handle) {
      setMissing(true);
      setLoading(false);
      setItems([]);
      setProfile(null);
      return;
    }
    const seq = ++loadSeqRef.current;
    const appending = before != null;
    if (appending) setLoadingMore(true);
    else {
      setLoading(true);
      setMissing(false);
      setError(null);
      setActionError(null);
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
      if (/API 404|API 400/.test(message)) {
        setMissing(true);
        setItems([]);
        setProfile(null);
      } else {
        setError('Could not load this profile.');
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

  const unpublishPost = useCallback(async (post: TimelinePost) => {
    setActionError(null);
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

  const goHome = () => {
    void navigate({ to: '/' });
  };

  return (
    <VStack className="profile content-column" gap={0}>
      <VStack gap={5} className="profile-body" paddingBlock={5}>
        {loading && (
          <VStack gap={5}>
            <ProfileHeaderSkeleton />
            <TimelineFeedSkeleton />
          </VStack>
        )}

        {!loading && missing && (
          <EmptyState
            title="Profile not found"
            description="That handle isn't claimed."
            icon={<Newspaper size={24} />}
            actions={<Button variant="secondary" label="Back to timeline" onClick={goHome} />}
          />
        )}

        {(error || actionError) && (
          <VStack gap={3} className="timeline-state">
            <Text className="timeline-err">{error ?? actionError}</Text>
            {error && (
              <Button variant="secondary" size="sm" label="Try again" onClick={() => { void load(); }} />
            )}
          </VStack>
        )}

        {!loading && !missing && profile && (
          <>
            <ProfileHeader profile={profile} onBack={goHome} />

            <VStack gap={3} className="profile-chats" as="section" aria-label="Public chats">
              <Heading level={2}>Public chats</Heading>
              <Text type="supporting">
                Chats this handle shared on the public timeline. Unlisted share links stay private.
              </Text>

              {!error && items.length === 0 && (
                <TimelineEmpty
                  handle={handle}
                  onAsk={() => { void navigate({ to: '/chat' }); }}
                />
              )}

              {items.length > 0 && (
                <VStack gap={0} className="timeline-feed" aria-busy={loadingMore || undefined}>
                  {items.map((post) => (
                    <TimelinePostRow
                      key={post.share_id}
                      post={post}
                      isAdmin={isAdmin}
                      showAuthor={false}
                      titleLevel={3}
                      onUnpublish={unpublishPost}
                    />
                  ))}
                </VStack>
              )}

              {nextBefore != null && (
                <HStack hAlign="center" className="timeline-more">
                  <Button
                    variant="secondary"
                    label="Load older chats"
                    isLoading={loadingMore}
                    onClick={() => { void load(nextBefore); }}
                  />
                </HStack>
              )}
            </VStack>
          </>
        )}
      </VStack>
    </VStack>
  );
}
