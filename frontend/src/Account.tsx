import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  FileInput,
  Heading,
  HStack,
  Spinner,
  Text,
  TextInput,
  VStack,
} from '@astryxdesign/core';
import { LogOut, UserRound } from 'lucide-react';
import { api, type ProfileMe } from './api';
import { authClient, signInWithGoogle, signOut } from './auth';
import { AvatarCropDialog } from './AvatarCropDialog';
import { HandleField } from './HandleField';
import { handleInputError, normalizeHandleInput } from './handle';
import {
  isSvgAvatarFile,
  prepareAvatarUpload,
  preloadImage,
  type AvatarCrop,
} from './prepareAvatar';
import { UserAvatar } from './UserAvatar';
import { ReplyStylePicker } from './ReplyStylePicker';
import './Account.css';

type PendingAvatar = {
  file: File;
  url: string;
  width: number;
  height: number;
};

function loadImageSize(file: File): Promise<{ url: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        url,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

const DISPLAY_NAME_MAX = 80;

/**
 * Signed-in account settings — handle, display name, avatar, reply voice, sign out.
 * Reached from the left-nav profile control (formerly an account popover).
 */
export default function AccountPage() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [profile, setProfile] = useState<ProfileMe | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<PendingAvatar | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);

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
      setNameDraft('');
      setError(null);
      setNameError(null);
      setAvatarError(null);
      setAvatarFile(null);
      setPendingAvatar((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      setAvatarPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setLoadingProfile(false);
      return;
    }
    let active = true;
    setLoadingProfile(true);
    api.me().then((me) => {
      if (!active) return;
      setProfile(me);
      setDraft(me.handle ?? me.suggested_handle ?? '');
      setNameDraft(me.display_name ?? me.name ?? '');
      setError(null);
      setNameError(null);
    }).catch(() => {
      if (active) setProfile(null);
    }).finally(() => {
      if (active) setLoadingProfile(false);
    });
    return () => { active = false; };
  }, [user]);

  if (isPending || (user && loadingProfile && !profile)) {
    return (
      <VStack className="account-page" gap={5} paddingBlock={6} paddingInline={5}>
        <Spinner size="md" label="Loading account" />
      </VStack>
    );
  }

  if (!user) {
    return (
      <VStack className="account-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={480}>
        <VStack gap={2}>
          <Heading level={1}>Account</Heading>
          <Text type="supporting">
            Sign in with Google to claim a public handle, set your display name and photo,
            and save how Lobster replies across devices.
          </Text>
        </VStack>
        {googleEnabled ? (
          <Button
            variant="primary"
            label="Sign in with Google"
            onClick={() => {
              void signInWithGoogle().catch((err) => {
                console.error('Google sign-in failed', err);
              });
            }}
          />
        ) : (
          <Text type="supporting">Google sign-in is not configured on this deployment.</Text>
        )}
      </VStack>
    );
  }

  const displayName = profile?.name || user.name || user.email || 'Account';
  const email = user.email && user.email !== displayName ? user.email : null;
  const currentHandle = profile?.handle ?? null;
  const canSaveHandle = !saving && !handleInputError(draft) && draft !== (currentHandle ?? '');
  const trimmedName = nameDraft.trim().replace(/\s+/g, ' ');
  const nameTooLong = trimmedName.length > DISPLAY_NAME_MAX;
  const currentDisplayName = (profile?.display_name ?? profile?.name ?? '').trim();
  const canSaveName = Boolean(currentHandle)
    && !savingName
    && !nameTooLong
    && trimmedName !== currentDisplayName
    && (trimmedName.length > 0 || Boolean(profile?.display_name));

  function applyProfilePatch(patch: {
    handle?: string | null;
    display_name?: string | null;
    avatar_url?: string | null;
    name?: string;
  }) {
    setProfile((prev) => (
      prev
        ? {
            ...prev,
            handle: patch.handle ?? prev.handle,
            display_name: patch.display_name !== undefined ? patch.display_name : prev.display_name,
            avatar_url: patch.avatar_url !== undefined ? patch.avatar_url : prev.avatar_url,
            name: patch.name ?? prev.name,
            suggested_handle: patch.handle ? null : prev.suggested_handle,
          }
        : prev
    ));
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
      applyProfilePatch(result);
      setDraft(result.handle ?? draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save handle');
    } finally {
      setSaving(false);
    }
  }

  async function saveName() {
    if (!currentHandle) {
      setNameError('Claim a handle first');
      return;
    }
    if (nameTooLong) {
      setNameError(`Name must be ${DISPLAY_NAME_MAX} characters or fewer`);
      return;
    }
    setSavingName(true);
    setNameError(null);
    try {
      const result = await api.updateProfile({
        display_name: trimmedName.length ? trimmedName : null,
      });
      applyProfilePatch(result);
      setNameDraft(result.display_name ?? result.name);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Could not save name');
    } finally {
      setSavingName(false);
    }
  }

  function clearPendingAvatar() {
    setPendingAvatar((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setAvatarFile(null);
  }

  function setOptimisticAvatarPreview(url: string | null) {
    setAvatarPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }

  async function uploadPreparedAvatar(file: File, crop?: AvatarCrop | null) {
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const prepared = await prepareAvatarUpload(file, crop);
      const result = await api.uploadAvatar(prepared.blob, prepared.contentType);
      applyProfilePatch(result);
      clearPendingAvatar();
      setOptimisticAvatarPreview(null);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not upload photo');
      throw err;
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function onAvatarChange(files: File | File[] | null) {
    const file = Array.isArray(files) ? files[0] ?? null : files;
    setAvatarFile(file);
    setAvatarError(null);
    if (!file) {
      clearPendingAvatar();
      return;
    }
    if (!currentHandle) {
      setAvatarError('Claim a handle before uploading a photo');
      setAvatarFile(null);
      return;
    }
    if (isSvgAvatarFile(file)) {
      try {
        await uploadPreparedAvatar(file);
      } catch {
        setAvatarFile(null);
      }
      return;
    }
    try {
      const sized = await loadImageSize(file);
      if (Math.min(sized.width, sized.height) < 32) {
        URL.revokeObjectURL(sized.url);
        setAvatarError('Image is too small');
        setAvatarFile(null);
        return;
      }
      setPendingAvatar((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { file, url: sized.url, width: sized.width, height: sized.height };
      });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not read that image');
      setAvatarFile(null);
    }
  }

  async function confirmAvatarCrop(crop: AvatarCrop) {
    const pending = pendingAvatar;
    if (!pending) throw new Error('No photo selected');

    const prepared = await prepareAvatarUpload(pending.file, crop);
    const preview = URL.createObjectURL(prepared.blob);
    setOptimisticAvatarPreview(preview);
    clearPendingAvatar();

    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const result = await api.uploadAvatar(prepared.blob, prepared.contentType);
      applyProfilePatch(result);
      const remote = api.avatarSrc(result.avatar_url);
      if (remote) {
        try {
          await preloadImage(remote);
        } catch {
          setAvatarError('Photo saved, but the server image failed to load. Try a refresh.');
          return;
        }
      }
      setOptimisticAvatarPreview(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not upload photo';
      setAvatarError(message);
      throw err;
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function removeAvatar() {
    if (!profile?.avatar_url && !avatarPreviewUrl) return;
    setUploadingAvatar(true);
    setAvatarError(null);
    try {
      const result = await api.clearAvatar();
      applyProfilePatch(result);
      clearPendingAvatar();
      setOptimisticAvatarPreview(null);
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : 'Could not remove photo');
    } finally {
      setUploadingAvatar(false);
    }
  }

  function onDraftChange(value: string) {
    setDraft(normalizeHandleInput(value));
    setError(null);
  }

  const avatarDisplayUrl = avatarPreviewUrl ?? profile?.avatar_url ?? null;

  return (
    <>
      <VStack className="account-page" gap={6} paddingBlock={6} paddingInline={5} maxWidth={480}>
        <VStack gap={2}>
          <Heading level={1}>Account</Heading>
          <Text type="supporting">
            Your public identity and how Lobster replies in Chat.
          </Text>
        </VStack>

        <HStack gap={3} vAlign="center">
          <UserAvatar avatarUrl={avatarDisplayUrl} className="account-avatar" alt="" />
          <VStack gap={0.5} className="account-identity-copy">
            <Text type="body" weight="semibold" maxLines={1}>{displayName}</Text>
            {currentHandle ? (
              <Link to="/u/$handle" params={{ handle: currentHandle }} className="account-handle-link">
                <Text type="supporting" maxLines={1}>@{currentHandle}</Text>
              </Link>
            ) : (
              <Text type="supporting">Choose a handle to publish a profile</Text>
            )}
            {email ? <Text type="supporting" maxLines={1}>{email}</Text> : null}
          </VStack>
        </HStack>

        {currentHandle ? (
          <VStack gap={3}>
            <TextInput
              label="Display name"
              description="Shown on your public profile. Leave blank to use your Google name."
              value={nameDraft}
              onChange={(value) => {
                setNameDraft(value);
                setNameError(null);
              }}
              startIcon={<UserRound size={16} />}
              placeholder={user.name || 'Your name'}
              status={nameError
                ? { type: 'error', message: nameError }
                : nameTooLong
                  ? { type: 'error', message: `Name must be ${DISPLAY_NAME_MAX} characters or fewer` }
                  : undefined}
            />
            <Button
              variant="secondary"
              size="sm"
              label={savingName ? 'Saving…' : 'Save name'}
              isDisabled={!canSaveName}
              onClick={() => { void saveName(); }}
            />
            <FileInput
              label="Profile photo"
              description="JPEG, PNG, WebP, or SVG — pan and zoom rasters to fill the circle; SVG stays vector. Up to 2 MB."
              value={avatarFile}
              onChange={(files) => { void onAvatarChange(files); }}
              accept="image/jpeg,image/png,image/webp,image/svg+xml,.svg"
              maxSize={2 * 1024 * 1024}
              mode="input"
              placeholder="Upload photo"
              isLoading={uploadingAvatar}
              status={avatarError ? { type: 'error', message: avatarError } : undefined}
            />
            {profile?.avatar_url || avatarPreviewUrl ? (
              <Button
                variant="ghost"
                size="sm"
                label="Remove photo"
                isDisabled={uploadingAvatar}
                onClick={() => { void removeAvatar(); }}
              />
            ) : null}
          </VStack>
        ) : null}

        <VStack gap={3}>
          <HandleField value={draft} error={error} onChange={onDraftChange} />
          <Button
            variant="primary"
            size="sm"
            label={currentHandle ? 'Save handle' : 'Choose handle'}
            isDisabled={!canSaveHandle}
            onClick={() => { void saveHandle(); }}
          />
        </VStack>

        <ReplyStylePicker />

        <Button
          variant="ghost"
          size="sm"
          label="Sign out"
          icon={<LogOut size={16} />}
          onClick={() => { void signOut(); }}
        />
      </VStack>

      <AvatarCropDialog
        open={pendingAvatar != null}
        imageUrl={pendingAvatar?.url ?? null}
        naturalWidth={pendingAvatar?.width ?? 0}
        naturalHeight={pendingAvatar?.height ?? 0}
        onCancel={() => {
          if (!uploadingAvatar) clearPendingAvatar();
        }}
        onConfirm={confirmAvatarCrop}
      />
    </>
  );
}
