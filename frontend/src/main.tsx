import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core';
import { lobsterTheme } from './theme';
import { RouterProvider } from '@tanstack/react-router';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
// Theme tokens are injected by lobsterTheme; the base component styles stay global.
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
    <Theme theme={lobsterTheme} mode="dark">
      <RouterProvider router={router} />
    </Theme>
  </StrictMode>,
);
