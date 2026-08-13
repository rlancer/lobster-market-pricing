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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={lobsterTheme} mode="dark">
      <RouterProvider router={router} />
    </Theme>
  </StrictMode>,
);
