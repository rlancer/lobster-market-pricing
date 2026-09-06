import { expect, test, type Page } from '@playwright/test';

async function mockSignedInSchwabBook(page: Page) {
  await page.route((url) => url.pathname === '/api/auth/get-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'sess-schwab-book',
          userId: 'user-schwab-book',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        user: {
          id: 'user-schwab-book',
          email: 'schwab-book@example.com',
          name: 'Schwab Book',
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
        id: 'user-schwab-book',
        name: 'Schwab Book',
        email: 'schwab-book@example.com',
        image: null,
        handle: 'schwabbook',
        display_name: 'Schwab Book',
        avatar_url: null,
        suggested_handle: 'schwabbook',
        is_admin: false,
      }),
    });
  });
  await page.route((url) => url.pathname === '/api/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, auth: { google: true, schwab: true } }),
    });
  });
  await page.route((url) => url.pathname === '/api/bots', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route((url) => url.pathname === '/api/schwab/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        configured: true,
        connected: true,
        connected_at: '2026-09-01T00:00:00.000Z',
        expires_at: '2026-09-05T00:00:00.000Z',
      }),
    });
  });
  await page.route((url) => url.pathname === '/api/schwab/portfolio', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        connected: true,
        fetched_at: '2026-09-04T15:00:00.000Z',
        accounts: [{
          id: 'schwab-0-1234',
          account_number_masked: '••••1234',
          type: 'BROKERAGE',
          cash: 12_000,
          equity: 54_321.5,
          buying_power: 20_000,
          day_pnl: 240.25,
          day_pnl_pct: 0.5,
          open_pnl: 1_850,
          positions: [
            {
              id: 'pos-aapl',
              symbol: 'AAPL',
              underlying: null,
              description: 'Apple Inc',
              asset_type: 'EQUITY',
              quantity: 40,
              average_price: 180,
              market_value: 8_400,
              day_pnl: 120.5,
              day_pnl_pct: 1.46,
              open_pnl: 1_200,
            },
          ],
        }],
        totals: {
          cash: 12_000,
          equity: 54_321.5,
          buying_power: 20_000,
          day_pnl: 240.25,
          day_pnl_pct: 0.5,
          open_pnl: 1_850,
          position_count: 1,
          account_count: 1,
        },
      }),
    });
  });
  await page.route((url) => url.pathname === '/api/schwab/pnl', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accounts: [{ id: 'schwab-0-1234', label: '••••1234' }],
        account: 'schwab-0-1234',
        range: 'YTD',
        start: '2026-01-01',
        end: '2026-09-04',
        points: [
          {
            date: '2026-01-15',
            daily_pnl: 100,
            cumulative_pnl: 100,
            daily_equity_pnl: 100,
            daily_option_pnl: 0,
            daily_fees: 0,
            daily_dividends: 0,
          },
          {
            date: '2026-08-15',
            daily_pnl: 200,
            cumulative_pnl: 300,
            daily_equity_pnl: 200,
            daily_option_pnl: 0,
            daily_fees: 0,
            daily_dividends: 0,
          },
          {
            date: '2026-09-02',
            daily_pnl: 50,
            cumulative_pnl: 350,
            daily_equity_pnl: 50,
            daily_option_pnl: 0,
            daily_fees: 0,
            daily_dividends: 0,
          },
        ],
        summary: {
          period_pnl: 350,
          prior_open_pnl: 0,
          distributions_total: 0,
          trade_count: 1,
          closing_trade_count: 0,
          unmatched_close_count: 0,
          skipped_trade_count: 0,
        },
        fills: [],
        distributions: [],
        trades: [],
      }),
    });
  });
}

test.describe('Schwab portfolio returns', () => {
  test('shows DTD, MTD, and YTD percent bubbles next to the dollar move', async ({ page }) => {
    await mockSignedInSchwabBook(page);
    await page.goto('/portfolio?book=schwab');

    await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
    await expect(page.getByText('$240.25')).toBeVisible();
    await expect(page.getByText('+0.50%').first()).toBeVisible();

    const returns = page.getByRole('group', { name: 'Portfolio return' });
    await expect(returns).toBeVisible();
    await expect(returns.getByText('DTD +0.50%')).toBeVisible();
    await expect(returns.getByText('MTD +0.09%')).toBeVisible();
    await expect(returns.getByText('YTD +0.65%')).toBeVisible();

    await expect(page.getByText('+$350.00').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Day PnL' })).toBeVisible();
    await expect(page.getByText('+1.46%')).toBeVisible();
    await page.screenshot({
      path: '/opt/cursor/artifacts/schwab_portfolio_return_bubbles.png',
      fullPage: true,
    });
  });

  test('hide dollars swaps cash and marks for percentages', async ({ page }) => {
    await mockSignedInSchwabBook(page);
    await page.goto('/portfolio?book=schwab');

    await expect(page.getByText('$12,000.00')).toBeVisible();
    await expect(page.getByText('$54,321.50')).toBeVisible();
    await expect(page.getByText('$240.25')).toBeVisible();
    await expect(page.getByText('+$350.00').first()).toBeVisible();
    await expect(page.getByText('$8,400.00')).toBeVisible();
    await expect(page.getByText('40', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Hide dollars' }).click();

    await expect(page.getByText('$12,000.00')).toHaveCount(0);
    await expect(page.getByText('$54,321.50')).toHaveCount(0);
    await expect(page.getByText('$240.25')).toHaveCount(0);
    await expect(page.getByText('+$350.00')).toHaveCount(0);
    await expect(page.getByText('$8,400.00')).toHaveCount(0);

    await expect(page.getByText('22.1%')).toBeVisible();
    await expect(page.getByText('100%')).toBeVisible();
    await expect(page.getByText('36.8%')).toBeVisible();
    await expect(page.getByText('+0.50%').first()).toBeVisible();
    await expect(page.getByText('+3.53%')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Weight' })).toBeVisible();
    await expect(page.getByText('15.5%')).toBeVisible();
    await expect(page.getByText('+16.7%')).toBeVisible();
    await expect(page.getByText('+1.46%')).toBeVisible();

    const returns = page.getByRole('group', { name: 'Portfolio return' });
    await expect(returns.getByText('DTD +0.50%')).toBeVisible();
    await expect(returns.getByText('YTD +0.65%')).toBeVisible();

    await page.screenshot({
      path: '/opt/cursor/artifacts/schwab_portfolio_hide_dollars.png',
      fullPage: true,
    });
  });
});
