import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Layout,
  LayoutContent,
  LayoutFooter,
  Popover,
  Text,
  TextInput,
  Tooltip,
  VStack,
} from '@astryxdesign/core';
import { AtSign, LogOut } from 'lucide-react';
import { api, type ProfileMe } from './api';
import { authClient, signInWithGoogle, signOut } from './auth';
import { handleInputError, normalizeHandleInput } from './handle';
import { ProfileSunglasses } from './Sunglasses';

const HANDLE_PROMPT_KEY = 'lobster.handle-prompt-dismissed';

function HandleField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const inputError = handleInputError(value);
  const status = error
    ? { type: 'error' as const, message: error }
    : value && inputError
      ? { type: 'error' as const, message: inputError }
      : undefined;
  return (
    <TextInput
      label="Handle"
      description={value ? `lobster.mp/u/${value}` : 'Letters and numbers only — this becomes your profile URL.'}
      value={value}
      onChange={onChange}
      startIcon={<AtSign size={16} />}
      placeholder="yourname"
      isRequired
      status={status}
    />
  );
}

/**
 * Optional Google account controls for the app header. Chat stays anonymous
 * by default; this only appears when the Worker has Google OAuth configured,
 * or when a session is already present. First sign-in claims a public handle.
 */
export function AuthControls() {
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
  }, [user]);

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
  const displayName = user.name || user.email || 'Account';
  const email = user.email && user.email !== displayName ? user.email : null;
  const currentHandle = profile?.handle ?? null;
  const canSave = !saving && !handleInputError(draft) && draft !== (currentHandle ?? '');

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
      const result = await api.setHandle(draft);
      setProfile((prev) => (
        prev
          ? { ...prev, handle: result.handle, suggested_handle: null }
          : prev
      ));
      setDraft(result.handle);
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
      <Popover
        placement="below"
        alignment="end"
        label="Account"
        width="20rem"
        content={
          <VStack gap={3}>
            <VStack gap={0.5}>
              <Text type="body" weight="semibold" maxLines={1}>{displayName}</Text>
              {currentHandle ? (
                <Link to="/u/$handle" params={{ handle: currentHandle }} className="topbar-handle-link">
                  <Text type="supporting" maxLines={1}>@{currentHandle}</Text>
                </Link>
              ) : null}
              {email ? <Text type="supporting" maxLines={1}>{email}</Text> : null}
            </VStack>
            <HandleField value={draft} error={error} onChange={onDraftChange} />
            <Button
              variant="primary"
              size="sm"
              label={currentHandle ? 'Save handle' : 'Choose handle'}
              isDisabled={!canSave}
              onClick={() => { void saveHandle(); }}
            />
            <Button
              variant="ghost"
              size="sm"
              label="Sign out"
              icon={<LogOut size={16} />}
              onClick={() => { void signOut(); }}
            />
          </VStack>
        }
      >
        <Tooltip content="Account" hasHoverIndication={false}>
          <button type="button" className="topbar-profile" aria-label="Account">
            <ProfileSunglasses className="topbar-profile-icon" />
          </button>
        </Tooltip>
      </Popover>
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
              subtitle="This is your public name. Letters and numbers only — no spaces or punctuation."
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
                  isDisabled={!canSave}
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
