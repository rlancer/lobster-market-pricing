import { expect, test } from '@playwright/test';

const SAMPLE = {
  as_of: '2026-09-04',
  source: 'quotes',
  indexes: {
    vix: { symbol: '^VIX', name: 'VIX', last: 15.2, prev: 16.1, change_pct: -5.59, date: '2026-09-04' },
    vix9d: { symbol: '^VIX9D', name: 'VIX9D', last: 14.1, prev: 15.0, change_pct: -6, date: '2026-09-04' },
    vix3m: { symbol: '^VIX3M', name: 'VIX3M', last: 17.4, prev: 17.8, change_pct: -2.25, date: '2026-09-04' },
    vvix: { symbol: '^VVIX', name: 'VVIX', last: 92.1, prev: 95, change_pct: -3.05, date: '2026-09-04' },
  },
  curve: [
    { tenor: 0, kind: 'spot', symbol: '^VIX', label: 'Spot', last: 15.2, prev: 16.1, change: -0.9, change_pct: -5.59, expiration: null, dte: null, volume: null, open_interest: null, bid: null, ask: null, settle: null },
    { tenor: 1, kind: 'future', symbol: 'VXU26', label: "Sep'26", last: 16.4, prev: 17, change: -0.6, change_pct: -3.53, expiration: '2026-09-16', dte: 12, volume: 120000, open_interest: 80000, bid: 16.3, ask: 16.5, settle: 16.45 },
    { tenor: 2, kind: 'future', symbol: 'VXV26', label: "Oct'26", last: 17.1, prev: 17, change: 0.1, change_pct: 0.59, expiration: '2026-10-21', dte: 47, volume: 90000, open_interest: 70000, bid: 17.0, ask: 17.2, settle: 17.05 },
  ],
  metrics: {
    shape: 'contango',
    m1_m2_pct: 4.27,
    m1_m2_pts: 0.7,
    m2_m3_pct: null,
    m4_m7_pct: null,
    vix_vs_m1_pct: 7.89,
    vix_vs_vix3m_pct: 14.47,
  },
  settlement_dates: ['2026-09-04', '2026-09-03'],
  history: [
    {
      date: '2026-09-03',
      points: [
        { tenor: 0, kind: 'spot', symbol: '^VIX', label: 'Spot', last: 16.1, prev: 16.4, change: -0.3, change_pct: -1.83, expiration: null, dte: null, volume: null, open_interest: null, bid: null, ask: null, settle: null },
        { tenor: 1, kind: 'future', symbol: 'VXU26', label: "Sep'26", last: 17, prev: 17.2, change: -0.2, change_pct: -1.16, expiration: '2026-09-16', dte: 13, volume: null, open_interest: null, bid: null, ask: null, settle: 17 },
      ],
    },
  ],
  fetched_at: '2026-09-04T20:00:00.000Z',
  errors: [],
};

test.describe('VIX term structure', () => {
  test('page shows the curve, tradable M1-M2 metric, and contract table', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/vix', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SAMPLE),
      });
    });

    await page.goto('/vix');
    await expect(page.getByRole('heading', { name: 'VIX term structure' })).toBeVisible();
    await expect(page.getByText(/Cash VIX is a calculated index/)).toBeVisible();
    await expect(page.getByText('M1–M2')).toBeVisible();
    await expect(page.getByText(/Front two VX monthals/)).toBeVisible();
    await expect(page.getByText("Sep'26")).toBeVisible();
    await expect(page.getByText('VXU26')).toBeVisible();
    await expect(page.getByRole('img', { name: 'VX futures term structure' })).toBeVisible();
  });

  test('research ^VIX redirects to /vix', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/vix', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SAMPLE),
      });
    });
    await page.goto('/research/%5EVIX');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/vix');
    await expect(page.getByRole('heading', { name: 'VIX term structure' })).toBeVisible();
  });
});
