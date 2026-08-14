import { useEffect, useState } from 'react';
import { Button, Popover, Text, Tooltip, VStack } from '@astryxdesign/core';
import { LogOut } from 'lucide-react';
import { api } from './api';
import { authClient, signInWithGoogle, signOut } from './auth';
import { ProfileSunglasses } from './Sunglasses';

/**
 * Optional Google account controls for the app header. Chat stays anonymous
 * by default; this only appears when the Worker has Google OAuth configured,
 * or when a session is already present.
 */
export function AuthControls() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user ?? null;
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    api.health().then((health) => {
      if (active) setGoogleEnabled(Boolean(health.auth?.google));
    }).catch(() => {
      if (active) setGoogleEnabled(false);
    });
    return () => { active = false; };
  }, []);

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

  const displayName = user.name || user.email || 'Account';
  const email = user.email && user.email !== displayName ? user.email : null;

  return (
    <Popover
      placement="below"
      alignment="end"
      label="Account"
      width="16rem"
      content={
        <VStack gap={3}>
          <VStack gap={0.5}>
            <Text type="body" weight="semibold" maxLines={1}>{displayName}</Text>
            {email ? <Text type="supporting" maxLines={1}>{email}</Text> : null}
          </VStack>
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
  );
}
