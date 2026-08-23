import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import {
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Text,
  VStack,
} from '@astryxdesign/core';
import { api, type ProfileMe } from './api';
import { authClient, signInWithGoogle } from './auth';
import { HandleField } from './HandleField';
import { handleInputError, normalizeHandleInput } from './handle';
import { UserAvatar } from './UserAvatar';

const HANDLE_PROMPT_KEY = 'lobster.handle-prompt-dismissed';

/**
 * Optional Google account controls for the left-nav footer. Chat stays anonymous
 * by default; this only appears when the Worker has Google OAuth configured,
 * or when a session is already present. First sign-in claims a public handle
 * via a dialog; full profile edit lives on /account.
 */
export function AuthControls() {
  const location = useLocation();
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [profile, setProfile] = useState<ProfileMe | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);

  useEffect(() => {
    let active = true;
    api.health().then((health) => {
      if (active) setGoogleEnabled(Boolean(health.auth?.google));
    }).catch(() => {
      if (active) setGoogleEnabled(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setDraft('');
      setError(null);
      setClaimOpen(false);
      return;
    }
    let active = true;
    api.me().then((me) => {
      if (!active) return;
      setProfile(me);
      setDraft(me.handle ?? me.suggested_handle ?? '');
      setError(null);
      if (!me.handle && sessionStorage.getItem(HANDLE_PROMPT_KEY) !== me.id) {
        setClaimOpen(true);
      }
    }).catch(() => {
      if (active) setProfile(null);
    });
    return () => { active = false; };
  }, [user, location.pathname]);

  if (isPending) return null;

  if (!user) {
    if (!googleEnabled) return null;
    return (
      <Button
        variant="ghost"
        size="sm"
        label="Sign in"
        onClick={() => {
          void signInWithGoogle().catch((err) => {
            console.error('Google sign-in failed', err);
          });
        }}
      />
    );
  }

  const userId = user.id;
  const displayName = profile?.name || user.name || user.email || 'Account';
  const currentHandle = profile?.handle ?? null;
  const canSaveHandle = !saving && !handleInputError(draft) && draft !== (currentHandle ?? '');
  const onAccount = location.pathname === '/account';

  function dismissClaim() {
    sessionStorage.setItem(HANDLE_PROMPT_KEY, userId);
    setClaimOpen(false);
  }

  async function saveHandle() {
    const invalid = handleInputError(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateProfile({ handle: draft });
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
      setDraft(result.handle ?? draft);
      setClaimOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save handle');
    } finally {
      setSaving(false);
    }
  }

  function onDraftChange(value: string) {
    setDraft(normalizeHandleInput(value));
    setError(null);
  }

  return (
    <>
      <Link
        to="/account"
        className="topbar-profile"
        aria-label={currentHandle ? `Account · ${displayName} (@${currentHandle})` : `Account · ${displayName}`}
        aria-current={onAccount ? 'page' : undefined}
      >
        <UserAvatar avatarUrl={profile?.avatar_url ?? null} className="topbar-profile-icon" alt="" />
        <VStack gap={0} className="topbar-profile-copy" hAlign="start">
          <Text type="body" weight="semibold" maxLines={1}>{displayName}</Text>
          {currentHandle ? (
            <Text type="supporting" maxLines={1}>@{currentHandle}</Text>
          ) : (
            <Text type="supporting" maxLines={1}>Choose a handle</Text>
          )}
        </VStack>
      </Link>
      <Dialog
        isOpen={claimOpen}
        onOpenChange={(open) => { if (!open) dismissClaim(); }}
        purpose="form"
        width={400}
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title="Choose a handle"
              subtitle="This is your public URL. Letters and numbers only — no spaces or punctuation. You can set your display name and photo after."
              onOpenChange={dismissClaim}
            />
          }
          content={
            <LayoutContent>
              <HandleField value={draft} error={error} onChange={onDraftChange} />
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} hAlign="end">
                <Button
                  variant="primary"
                  label={saving ? 'Saving…' : 'Save handle'}
                  isDisabled={!canSaveHandle}
                  onClick={() => { void saveHandle(); }}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </>
  );
}
