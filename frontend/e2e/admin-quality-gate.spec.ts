import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'robert.lancer@gmail.com';

const FIXTURE = {
  summary: {
    window_ms: 7 * 24 * 60 * 60 * 1000,
    decisions: 4,
    allowed: 2,
    rejected: 1,
    fail_open: 1,
    remediator_unlisted: 1,
    last_sweep: { created_at: Date.now() - 60_000, scanned: 34, unlisted: 0 },
  },
  events: [
    {
      event_id: 'evt-allow-1',
      created_at: Date.now() - 120_000,
      action: 'allow_bot_share',
      allow: true,
      source: 'heuristic',
      reason: 'ok',
      share_id: 'shareAllow1',
      run_id: 'run-1',
      bot_handle: 'macrolobster',
      model: 'test-model',
      extra: null,
    },
    {
      event_id: 'evt-reject-1',
      created_at: Date.now() - 180_000,
      action: 'reject_bot_share',
      allow: false,
      source: 'heuristic',
      reason: 'leaked prompt debate',
      share_id: 'shareReject1',
      run_id: 'run-2',
      bot_handle: 'macrolobster',
      model: 'test-model',
      extra: null,
    },
    {
      event_id: 'evt-failopen-1',
      created_at: Date.now() - 240_000,
      action: 'allow_bot_share',
      allow: true,
      source: 'fail_open',
      reason: 'moderator unavailable',
      share_id: 'shareFailOpen1',
      run_id: 'run-3',
      bot_handle: 'nowlobster',
      model: 'test-model',
      extra: null,
    },
    {
      event_id: 'evt-unlist-1',
      created_at: Date.now() - 300_000,
      action: 'remoderate_unlist',
      allow: false,
      source: 'remediator',
      reason: 'desk stub leftover',
      share_id: 'shareUnlist1',
      run_id: null,
      bot_handle: 'macrolobster',
      model: null,
      extra: null,
    },
  ],
  improvements: [
    {
      fingerprint: 'fp-1',
      title: 'Floor share leaked tool-loop narration',
      category: 'quality',
      issue_number: 331,
      issue_url: 'https://github.com/rlancer/lobster-market-pricing/issues/331',
      share_id: 'shareReject1',
      bot_handle: 'macrolobster',
      moderation_action: 'reject_bot_share',
      moderation_allow: false,
      created_at: Date.now() - 400_000,
    },
  ],
};

async function mockAdminQualityGate(page: Page) {
  await page.route((url) => url.pathname === '/api/auth/get-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'sess-quality-gate',
          userId: 'user-admin',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        user: {
          id: 'user-admin',
          email: ADMIN_EMAIL,
          name: 'Rob',
          image: null,
        },
      }),
    });
  });
  await page.route((url) => url.pathname === '/api/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        id: 'user-admin',
        name: 'Rob',
        email: ADMIN_EMAIL,
        image: null,
        handle: 'thelobster',
        display_name: 'Rob',
        avatar_url: null,
        suggested_handle: 'thelobster',
        is_admin: true,
      }),
    });
  });
  await page.route((url) => url.pathname === '/api/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, auth: { google: true, schwab: false } }),
    });
  });
  await page.route((url) => url.pathname === '/api/bots', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route((url) => url.pathname === '/api/chats', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route((url) => url.pathname === '/api/stats', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true }),
    });
  });
  await page.route((url) => url.pathname === '/api/runs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ as_of_date: '2026-09-05', status: 'complete' }]),
    });
  });
  await page.route((url) => url.pathname === '/api/admin/quality-gate', async (route) => {
    const requestUrl = new URL(route.request().url());
    const action = requestUrl.searchParams.get('action');
    const source = requestUrl.searchParams.get('source');
    const events = FIXTURE.events.filter((event) => {
      if (action && event.action !== action) return false;
      if (source && event.source !== source) return false;
      return true;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...FIXTURE, events }),
    });
  });
  await page.route((url) => url.pathname === '/api/admin/quality-gate/remoderate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, scanned: 34, unlisted: 0 }),
    });
  });
}

test.describe('Admin quality gate', () => {
  test('hub lists the monitor and the page filters, sweeps, and shows tickets', async ({ page }) => {
    await mockAdminQualityGate(page);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    await expect(page.getByText('Quality gate', { exact: true })).toBeVisible();
    await expect(page.getByText(/Watch the Floor monitor/)).toBeVisible();

    await page.getByText('Quality gate', { exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/quality-gate');
    await expect(page).toHaveTitle(/Quality gate/);
    await expect(page.getByRole('heading', { name: 'Quality gate' })).toBeVisible();
    await expect(page.getByText('Decisions 4')).toBeVisible();
    await expect(page.getByText('Allowed 2')).toBeVisible();
    await expect(page.getByText('Rejected 1')).toBeVisible();
    await expect(page.getByText('Fail-open 1')).toBeVisible();
    await expect(page.getByText('Unlisted later 1')).toBeVisible();
    await expect(page.getByText(/Last sweep scanned 34, unlisted 0/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recent decisions' })).toBeVisible();
    await expect(page.getByText('@macrolobster').first()).toBeVisible();
    await expect(page.getByText('leaked prompt debate')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Improvement tickets' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Floor share leaked tool-loop narration' })).toBeVisible();

    await page.getByText('Rejected 1').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('action')).toBe('reject_bot_share');
    await expect(page.getByText('leaked prompt debate')).toBeVisible();
    await expect(page.getByText('moderator unavailable')).toHaveCount(0);

    await page.getByRole('button', { name: 'Run remediator now' }).click();
    await expect(page.getByText('Scanned 34, unlisted 0.')).toBeVisible();
  });

  test('non-admin visitors are sent home', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    });
    await page.goto('/admin/quality-gate');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });
});
