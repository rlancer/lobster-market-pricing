import { useEffect, useState, type ReactNode } from 'react';
import { Button, Heading, Text, VStack } from '@astryxdesign/core';
import { api } from './api';
import { signInWithGoogle } from './auth';

/**
 * Signed-out destination for account-owned pages (Portfolio, My bots, Account).
 * The page itself is the empty state — no buried CTA under signed-in chrome.
 */
export function SignInEmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
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

  return (
    <VStack className={className} gap={5} paddingBlock={6} paddingInline={5} maxWidth={560}>
      <VStack gap={2}>
        <Heading level={1}>{title}</Heading>
        <Text type="supporting">{children}</Text>
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
