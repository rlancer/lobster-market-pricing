import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Copilot e2e exercises the real server-funded chat against the local stack:
//   - Worker: `wrangler dev` on 127.0.0.1:8787 (needs worker/.dev.vars with
//     OPEN_ROUTER_KEY, TAVILY_API_KEY / FRED_API_KEY / R2_SQL_TOKEN)
//   - Frontend: `vite` on 127.0.0.1:5173 with VITE_API_BASE pinned to the
//     local worker. No model key or model choice is ever injected into the browser.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Keep live-model tests skippable on machines without the Worker's local
// secret. Only presence is exposed to specs; the key value remains in .dev.vars.
const workerVars = resolve(ROOT, 'worker', '.dev.vars');
const hasOpenRouterSecret = existsSync(workerVars) && readFileSync(workerVars, 'utf8')
  .split(/\r?\n/)
  .some((line) => /^\s*OPEN_ROUTER_KEY\s*=\s*\S+/.test(line));
process.env.COPILOT_E2E_READY = hasOpenRouterSecret ? '1' : '';

const LOCAL_WORKER_URL = 'http://127.0.0.1:8787';
const FRONTEND_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // LLM turns are slow (schema fetch + tool loop + answer) and share one
  // server-side funded key, so tests run serially. The configured model is
  // deterministic; one retry absorbs upstream/provider flakes.
  retries: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: FRONTEND_URL,
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Local Worker backend (news/web_search/econ_calendar/tables all live
      // here). `reuseExistingServer` keeps `wrangler dev` running across runs.
      command: 'node node_modules/wrangler/bin/wrangler.js dev --port 8787 --ip 127.0.0.1',
      cwd: resolve(ROOT, 'worker'),
      url: `${LOCAL_WORKER_URL}/api/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // Local frontend. VITE_API_BASE is pinned to the local worker so the
      // browser talks to the code under test, not the deployed worker.
      command: 'node node_modules/vite/bin/vite.js --port 5173 --strictPort --host 127.0.0.1',
      cwd: resolve(ROOT, 'frontend'),
      env: { VITE_API_BASE: LOCAL_WORKER_URL },
      url: FRONTEND_URL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});