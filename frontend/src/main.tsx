import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { RouterProvider } from '@tanstack/react-router';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './index.css';
import { router } from './router.tsx';

// OpenRouter's OAuth whitelists `localhost:<port>` for local callbacks but
// treats `127.0.0.1`/`0.0.0.0` as a different (non-whitelisted) host. Since the
// PKCE verifier + API key live in host-scoped session/localStorage, the whole
// session must run under one canonical host for "Connect with OpenRouter" to
// work locally. Canonicalize to `localhost` before anything runs.
(function canonicalizeLocalHost() {
  const host = window.location.hostname;
  if (host === '127.0.0.1' || host === '0.0.0.0') {
    const url = new URL(window.location.href);
    url.hostname = 'localhost';
    window.location.replace(url.toString());
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="dark">
      <RouterProvider router={router} />
    </Theme>
  </StrictMode>,
);
