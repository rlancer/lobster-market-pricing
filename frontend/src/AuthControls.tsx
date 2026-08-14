import { useEffect, useState } from 'react';
import { Avatar, Button, HStack, IconButton, Text } from '@astryxdesign/core';
import { LogOut } from 'lucide-react';
import { api } from './api';
import { authClient, signInWithGoogle, signOut } from './auth';

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
  return (
    <HStack gap={2} vAlign="center" className="topbar-auth">
      <Avatar
        size="sm"
        name={displayName}
        src={user.image ?? undefined}
        tooltip={user.email || displayName}
      />
      <Text type="supporting" className="topbar-user-name" maxLines={1} textWrap="nowrap">
        {displayName}
      </Text>
      <IconButton
        variant="ghost"
        size="sm"
        label="Sign out"
        icon={<LogOut size={16} />}
        tooltip="Sign out"
        onClick={() => { void signOut(); }}
      />
    </HStack>
  );
}
