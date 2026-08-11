import { defineConfig } from '@playwright/test';

// ---------------------------------------------------------------------------
// Remote e2e config for the mobile SSE-drop reproduction (mobile-resume.spec).
// Runs the SAME spec against either the production or the staging deployment —
// no local webServer, no local model key. The browser (mobile viewport + UA)
// talks to the already-deployed frontend, whose baked-in VITE_API_BASE points
// at the matching worker:
//
//   prod    → https://robs-options-slop.pages.dev        + screener-api
//   staging → https://robs-options-slop-dev.pages.dev    + screener-api-dev
//
// Select with E2E_TARGET=prod|staging. The worker API base is re-exposed as
// E2E_API_URL so the spec can probe the resume endpoint directly.
// ---------------------------------------------------------------------------

const TARGETS = {
  prod: {
    baseURL: 'https://robs-options-slop.pages.dev',
    api: 'https://screener-api.robertlancer.workers.dev',
  },
  staging: {
    baseURL: 'https://robs-options-slop-dev.pages.dev',
    api: 'https://screener-api-dev.robertlancer.workers.dev',
  },
} as const;

const targetName = (process.env.E2E_TARGET ?? 'staging') as keyof typeof TARGETS;
const target = TARGETS[targetName];
if (!target) throw new Error(`Unknown E2E_TARGET '${targetName}' — expected 'prod' | 'staging'`);
process.env.E2E_API_URL = target.api;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/mobile-resume.spec.ts',
  timeout: 480_000, // high-reasoning agent runs + resume poll take minutes
  expect: { timeout: 30_000 },
  retries: 0, // live reproductions are spend-heavy; don't double-bill on flakes
  reporter: [['list']],
  outputDir: 'test-results-remote',
  use: {
    baseURL: target.baseURL,
    // Mobile context: this is the "on mobile" bug, keep the repro faithful.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
});
