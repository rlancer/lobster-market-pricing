import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  ChatComposer,
  ChatSendButton,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
  VStack,
} from '@astryxdesign/core';
import { ChatComposerInput } from '@astryxdesign/core/Chat';
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
import { HandleField } from './HandleField';
import { handleInputError, normalizeHandleInput } from './handle';

/**
 * Compact ChatComposer follow-up — send lives inside the field, same as /chat.
 * Sign-in / handle claim only open after submit.
 */
export function TimelineFollowUp({
  shareId,
  postHandle,
  continuePrompt = null,
}: {
  shareId: string;
  /** Timeline post author — used only for copy; fork attribution comes from the API. */
  postHandle?: string;
  /** When the shared answer sealed empty after tools, offer Continue with this finish prompt. */
  continuePrompt?: string | null;
}) {
  const navigate = useNavigate();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [profile, setProfile] = useState<ProfileMe | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signInOpen, setSignInOpen] = useState(false);
  const [handleOpen, setHandleOpen] = useState(false);
  const [handleDraft, setHandleDraft] = useState('');
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleSaving, setHandleSaving] = useState(false);
  const resumeTriedRef = useRef(false);
  const pendingQuestionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    let alive = true;
    setProfileLoading(true);
    api.me()
      .then((me) => {
        if (!alive) return;
        setProfile(me);
        setHandleDraft(me.handle ?? me.suggested_handle ?? '');
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
      pendingQuestionRef.current = null;
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
      setSignInOpen(false);
      setHandleOpen(false);
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
    if (!user) return;
    const pending = peekPendingFork();
    if (!pending || pending.share_id !== shareId) return;
    if (!profile?.handle) {
      pendingQuestionRef.current = pending.question;
      setValue(pending.question);
      setHandleOpen(true);
      resumeTriedRef.current = true;
      return;
    }
    resumeTriedRef.current = true;
    setValue(pending.question);
    void launchFork(pending.question);
  }, [busy, launchFork, profile?.handle, profileLoading, sessionPending, shareId, user]);

  const onSubmit = (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    pendingQuestionRef.current = question;
    if (!user) {
      stashPendingFork(shareId, question);
      setSignInOpen(true);
      return;
    }
    if (!profile?.handle) {
      stashPendingFork(shareId, question);
      setHandleDraft(profile?.suggested_handle ?? handleDraft);
      setHandleOpen(true);
      return;
    }
    void launchFork(question);
  };

  const startGoogleSignIn = () => {
    const question = (pendingQuestionRef.current ?? value).trim();
    if (question) stashPendingFork(shareId, question);
    void signInWithGoogle().catch((err) => {
      console.error('Google sign-in failed', err);
      setError('Sign-in failed. Try again.');
    });
  };

  const saveHandleAndFork = async () => {
    const invalid = handleInputError(handleDraft);
    if (invalid) {
      setHandleError(invalid);
      return;
    }
    setHandleSaving(true);
    setHandleError(null);
    try {
      const result = await api.updateProfile({ handle: handleDraft });
      setProfile((prev) => (
        prev
          ? {
              ...prev,
              handle: result.handle ?? prev.handle,
              suggested_handle: result.handle ? null : prev.suggested_handle,
              name: result.name ?? prev.name,
              display_name: result.display_name !== undefined ? result.display_name : prev.display_name,
            }
          : prev
      ));
      const question = (pendingQuestionRef.current ?? value).trim();
      if (question) await launchFork(question);
      else setHandleOpen(false);
    } catch (err) {
      setHandleError(err instanceof Error ? err.message : 'Could not save handle');
    } finally {
      setHandleSaving(false);
    }
  };

  return (
    <VStack
      as="section"
      gap={2}
      className="timeline-followup"
      aria-label="Ask a follow-up"
    >
      {continuePrompt?.trim() ? (
        <HStack gap={2} vAlign="center" className="ai-scope-lock-hint">
          <span>Answer interrupted before it finished. Continue to complete it.</span>
          <Button
            variant="secondary"
            label="Continue"
            onClick={() => onSubmit(continuePrompt)}
            isDisabled={busy}
          />
        </HStack>
      ) : null}
      <ChatComposer
        value={value}
        onChange={setValue}
        onSubmit={onSubmit}
        placeholder="Ask a follow-up…"
        density="compact"
        elevation="none"
        isDisabled={busy}
        input={<ChatComposerInput maxRows={4} hasHistory={false} />}
        sendButton={<ChatSendButton />}
      />

      {error && (
        <Text className="timeline-err" role="alert">{error}</Text>
      )}

      <Dialog
        isOpen={signInOpen}
        onOpenChange={setSignInOpen}
        purpose="info"
        width={400}
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="Sign in to continue"
              subtitle="Follow-ups need a Google account so we can show who asked."
              onOpenChange={(open) => { if (!open) setSignInOpen(false); }}
            />
          }
          content={
            <LayoutContent>
              <Text type="supporting">
                We’ll pick up your question after you sign in.
              </Text>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  variant="secondary"
                  label="Cancel"
                  onClick={() => setSignInOpen(false)}
                />
                <Button
                  variant="primary"
                  label="Sign in with Google"
                  isLoading={busy}
                  onClick={startGoogleSignIn}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>

      <Dialog
        isOpen={handleOpen}
        onOpenChange={(open) => { if (!open) setHandleOpen(false); }}
        purpose="form"
        width={400}
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="Choose a public handle"
              subtitle="Follow-ups are attributed to your handle on the timeline."
              onOpenChange={(open) => { if (!open) setHandleOpen(false); }}
            />
          }
          content={
            <LayoutContent>
              <HandleField
                value={handleDraft}
                error={handleError}
                onChange={(next) => {
                  setHandleDraft(normalizeHandleInput(next));
                  setHandleError(null);
                }}
              />
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  variant="secondary"
                  label="Cancel"
                  onClick={() => setHandleOpen(false)}
                />
                <Button
                  variant="primary"
                  label="Continue"
                  isLoading={handleSaving || busy}
                  isDisabled={Boolean(handleInputError(handleDraft))}
                  onClick={() => { void saveHandleAndFork(); }}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </VStack>
  );
}
