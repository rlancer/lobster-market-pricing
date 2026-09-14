import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';

const ADMIN_EMAIL = 'robert.lancer@gmail.com';

const FIXTURE = {
  fetched_at: new Date().toISOString(),
  executor: {
    job_id: 'kalshi-parlay-executor',
    enabled: true,
    cadence_seconds: 300,
    market_gated: false,
    next_attempt_after: Date.now() + 60_000,
    last_success_at: Date.now() - 120_000,
    consecutive_failures: 0,
    last_error: null,
    last_pass_at: Date.now() - 90_000,
    last_pass_duration_ms: 1400,
    pass_attempted: 1,
    execute: false,
    live: false,
    idle_reason: 'execute_off',
    open_combos: 80,
    open_legs: 400,
    combo_legs: 80,
    two_leg: 7,
    same_game_two_leg: 0,
    cross_game_two_leg: 7,
    missing_leg_mids: 0,
    attempted: 0,
    would_accept: 0,
    accepted: 0,
    skipped: 0,
    decisions: [],
    samples: [],
  },
  hourly: {
    job_id: 'kalshi-markets-hourly',
    enabled: true,
    last_success_at: Date.now() - 1_800_000,
    last_pass_at: Date.now() - 1_800_000,
    last_error: null,
    rfq_probe: 'research_tape_never_accepts',
    live: false,
  },
  loop: { passing: false, next_alarm: Date.now() + 5_000 },
  errors: { hourly: null, loop: null },
};

async function mockAdminSession(page: Page) {
  await page.route((url) => url.pathname === '/api/auth/get-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'sess-kalshi-parlay',
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
}

async function mockAdminKalshiParlay(page: Page) {
  await mockAdminSession(page);
  const loaderHits: string[] = [];
  await page.route((url) => url.hostname.includes('cboe-to-r2') || url.hostname.includes('kalshi.com'), async (route) => {
    loaderHits.push(route.request().url());
    await route.abort();
  });
  await page.route((url) => url.pathname === '/api/admin/kalshi-parlay', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE),
    });
  });
  await page.route((url) => url.pathname === '/api/admin/kalshi-parlay/trigger', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, job: 'kalshi-parlay-executor', background: true, note: 'forced pass started' }),
    });
  });
  return loaderHits;
}

if (process.env.PLAYWRIGHT_CHROME_PATH) {
  test.use({
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROME_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  });
}

test.describe('Admin Kalshi parlay console', () => {
  test('hub lists the bot and the page shows last_pass counts without hitting the loader', async ({ page }) => {
    const loaderHits = await mockAdminKalshiParlay(page);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    await expect(page.getByText('Kalshi parlay bot', { exact: true })).toBeVisible();
    if (existsSync('/opt/cursor/artifacts')) {
      await page.setViewportSize({ width: 1280, height: 1400 });
      await page.getByText('Kalshi parlay bot', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({
        path: '/opt/cursor/artifacts/admin_hub_kalshi_parlay.png',
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    await page.getByText('Kalshi parlay bot', { exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/kalshi-parlay');
    await expect(page).toHaveTitle(/Kalshi parlay bot/);
    await expect(page.getByRole('heading', { name: 'Kalshi parlay bot' })).toBeVisible();
    await expect(page.getByText('Idle', { exact: true })).toBeVisible();
    await expect(page.getByText('EXECUTE off', { exact: true })).toBeVisible();
    await expect(page.getByText('Open combos 80')).toBeVisible();
    await expect(page.getByText('Same-game two-leg 0')).toBeVisible();
    await expect(page.getByText('Cross-game two-leg 7')).toBeVisible();
    await expect(page.getByText(/Monday midday had 80 open combos/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Force dry-run pass' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Kalshi parlays' })).toHaveAttribute('href', '/experiments/kalshi-parlays');
    expect(loaderHits).toEqual([]);
    if (existsSync('/opt/cursor/artifacts')) {
      await page.screenshot({
        path: '/opt/cursor/artifacts/admin_kalshi_parlay_console.png',
        fullPage: true,
      });
    }
  });

  test('non-admin visitors are sent home', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/auth/get-session', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    });
    await page.goto('/admin/kalshi-parlay');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    if (existsSync('/opt/cursor/artifacts')) {
      await page.screenshot({
        path: '/opt/cursor/artifacts/admin_kalshi_parlay_signed_out.png',
        fullPage: true,
      });
    }
  });
});
