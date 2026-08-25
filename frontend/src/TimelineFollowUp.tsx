import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Button,
  ChatComposer,
  ChatSendButton,
  HStack,
  Text,
  VStack,
} from '@astryxdesign/core';
import { api, type ProfileMe } from './api';
import { authClient, signInWithGoogle } from './auth';
import {
  clearPendingFork,
  notifyChatsChanged,
  peekPendingFork,
  rememberChatId,
  stashForkContext,
  stashPendingFork,
  stashPendingPrompt,
} from './chatSession';
import { UserAvatar } from './UserAvatar';

/**
 * Per-post follow-up composer for the timeline / share page.
 * Requires Google sign-in + a claimed public handle so the asker can be shown
 * when the forked chat is shared back to the feed.
 */
export function TimelineFollowUp({
  shareId,
  postHandle,
}: {
  shareId: string;
  /** Timeline post author — used only for copy; fork attribution comes from the API. */
  postHandle?: string;
}) {
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [profile, setProfile] = useState<ProfileMe | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeTriedRef = useRef(false);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    let alive = true;
    setProfileLoading(true);
    api.me()
      .then((me) => {
        if (alive) setProfile(me);
      })
      .catch(() => {
        if (alive) setProfile(null);
      })
      .finally(() => {
        if (alive) setProfileLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [user]);

  const launchFork = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.forkChat(shareId, trimmed);
      clearPendingFork();
      stashPendingPrompt(result.question);
      stashForkContext({
        parent_share_id: result.parent_share_id,
        parent_handle: result.parent_author?.handle ?? postHandle ?? null,
        parent_name: result.parent_author?.name ?? null,
        fork_seed_count: result.fork_seed_count,
      });
      rememberChatId(result.chat_id);
      notifyChatsChanged();
      setValue('');
      void navigate({
        to: '/chat/$chatId',
        params: { chatId: result.chat_id },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start follow-up.');
    } finally {
      setBusy(false);
    }
  }, [busy, navigate, postHandle, shareId]);

  // After Google OAuth round-trip, finish a stashed follow-up for this share.
  useEffect(() => {
    if (resumeTriedRef.current || sessionPending || profileLoading || busy) return;
    if (!user || !profile?.handle) return;
    const pending = peekPendingFork();
    if (!pending || pending.share_id !== shareId) return;
    resumeTriedRef.current = true;
    setValue(pending.question);
    void launchFork(pending.question);
  }, [busy, launchFork, profile?.handle, profileLoading, sessionPending, shareId, user]);

  const onSubmit = (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    if (!user) {
      stashPendingFork(shareId, question);
      void signInWithGoogle().catch((err) => {
        console.error('Google sign-in failed', err);
        setError('Sign-in failed. Try again.');
      });
      return;
    }
    if (!profile?.handle) {
      stashPendingFork(shareId, question);
      setError('Claim a public handle to ask a follow-up.');
      return;
    }
    void launchFork(question);
  };

  const signedIn = Boolean(user);
  const hasHandle = Boolean(profile?.handle);
  const placeholder = !signedIn
    ? 'Sign in to ask a follow-up…'
    : !hasHandle
      ? 'Claim a handle to ask a follow-up…'
      : 'Ask a follow-up about this chat…';

  return (
    <VStack
      as="section"
      gap={2}
      className="timeline-followup"
      aria-label="Ask a follow-up"
    >
      <HStack gap={2} vAlign="center" className="timeline-followup-head">
        {signedIn ? (
          <UserAvatar
            avatarUrl={profile?.avatar_url}
            className="timeline-followup-avatar"
            alt=""
          />
        ) : null}
        <Text type="supporting" className="timeline-followup-label">
          {signedIn && hasHandle
            ? `Continue as @${profile!.handle}`
            : signedIn
              ? 'Continue this chat with your own follow-up'
              : 'Have a follow-up? Sign in so we can show who asked.'}
        </Text>
      </HStack>

      <ChatComposer
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder={placeholder}
        density="compact"
        isDisabled={busy || profileLoading}
        sendButton={<ChatSendButton />}
      />

      {!signedIn && (
        <HStack gap={2} vAlign="center" className="timeline-followup-gate">
          <Button
            variant="secondary"
            size="sm"
            label="Sign in with Google"
            isDisabled={busy}
            onClick={() => {
              const draft = value.trim();
              if (draft) stashPendingFork(shareId, draft);
              void signInWithGoogle().catch((err) => {
                console.error('Google sign-in failed', err);
                setError('Sign-in failed. Try again.');
              });
            }}
          />
        </HStack>
      )}

      {signedIn && !hasHandle && !profileLoading && (
        <HStack gap={2} vAlign="center" className="timeline-followup-gate">
          <Text type="supporting">
            <Link to="/account" className="timeline-followup-account">
              Claim a public handle
            </Link>
            {' '}
            so follow-ups are attributed to you.
          </Text>
        </HStack>
      )}

      {error && (
        <Text className="timeline-err" role="alert">{error}</Text>
      )}
    </VStack>
  );
}
