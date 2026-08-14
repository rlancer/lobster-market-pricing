import { createAuthClient } from 'better-auth/react';
import { API_BASE } from './api';

export const authClient = createAuthClient({
  baseURL: API_BASE || undefined,
  fetchOptions: {
    credentials: 'include',
  },
});

export function signInWithGoogle(): Promise<unknown> {
  return authClient.signIn.social({
    provider: 'google',
    callbackURL: window.location.href,
  });
}

export function signOut(): Promise<unknown> {
  return authClient.signOut();
}
