import { expect, test } from '@playwright/test';

const LOCAL_WORKER = 'http://127.0.0.1:8787';

test.describe('Public timeline', () => {
  test('home page is the timeline and Chat lives at /chat', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Timeline' }).first()).toBeVisible();

    await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('GET /api/timeline is public and returns a feed envelope', async ({ request }) => {
    const res = await request.get(`${LOCAL_WORKER}/api/timeline`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      next_before: number | null;
      profile: unknown;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.next_before === null || typeof body.next_before === 'number').toBe(true);
    expect('profile' in body).toBe(true);
  });

  test('publishing to the timeline requires a session', async ({ request }) => {
    const res = await request.post(`${LOCAL_WORKER}/api/timeline`, {
      data: { share_id: 'notarealshare' },
    });
    expect(res.status()).toBe(401);
  });
});
