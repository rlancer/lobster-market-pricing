import { expect, test } from '@playwright/test';

test.describe('Per-route document meta', () => {
  test('research ticker is in the title and Open Graph tags', async ({ page }) => {
    await page.goto('/research/SPY');
    await expect(page).toHaveTitle(/SPY/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /SPY/);
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute('content', /SPY/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /SPY/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/research\/SPY$/);
  });

  test('profile handle is in the timeline title', async ({ page }) => {
    await page.goto('/u/thelobster');
    await expect(page).toHaveTitle(/@thelobster/);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /@thelobster/);
  });

  test('docs topic is in the title', async ({ page }) => {
    await page.goto('/docs/pipeline');
    await expect(page).toHaveTitle(/Data pipeline/);
  });

  test('home keeps the brand title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Ask the Lobster/);
  });
});
