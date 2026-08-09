import { defineConfig } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Copilot e2e — exercises the real chat against the real local stack:
//   - Worker: `wrangler dev` on 127.0.0.1:8787 (needs worker/.dev.vars with
//     TAVILY_API_KEY / FRED_API_KEY / R2_SQL_TOKEN, all gitignored)
//   - Frontend: `vite` on 127.0.0.1:5173 with VITE_API_BASE pinned to the
//     local worker (overrides frontend/.env's deployed-URL base at process
//     level — Vite never overrides an existing process env var)
//   - OpenRouter: the user's BYOK key from the repo root `.env`
//     (OPEN_ROUTER_LOCAL_DEV_KEY, gitignored) is injected into localStorage
//     (`openinterest_ai_key`) before the app boots, exactly like the app's
//     Settings panel does.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Explicit env wins; otherwise fall back to the root .env copy used for local
// dev. A missing key skips the chat tests with a clear message (see spec).
function loadOpenRouterKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return '';
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*OPEN_ROUTER_LOCAL_DEV_KEY\s*=\s*(.*)\s*$/);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return '';
}

const OPENROUTER_KEY = loadOpenRouterKey();
if (OPENROUTER_KEY) process.env.OPENROUTER_API_KEY = OPENROUTER_KEY;

const LOCAL_WORKER_URL = 'http://127.0.0.1:8787';
const FRONTEND_URL = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  // The Copilot LLM turns are slow (schema fetch + tool loop + answer) and the
  // OpenRouter key is rate-limited by account; one worker, no parallel chat.
  workers: 1,
  fullyParallel: false,
  // Answer content from openrouter/auto is nondeterministic: a full run can
  // occasionally end with an empty final message. One retry absorbs that class
  // of flake; endpoint-utilization assertions are deterministic either way.
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