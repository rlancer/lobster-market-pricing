import { expect, test } from '@playwright/test';

const LOCAL_WORKER = 'http://127.0.0.1:8787';

test.describe('Public timeline', () => {
  test('home page is the timeline and Chat lives at /chat', async ({ page }) => {
    await page.goto('/');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Timeline' }).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

    await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('timeline composer opens a new chat with the typed prompt', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByRole('region', { name: 'Ask the Lobster' }).getByRole('textbox', { name: 'Message input' });
    await expect(composer).toBeVisible();
    await composer.fill('Find the most liquid calls expiring within 30 days');
    await composer.press('Enter');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
    // Either still queued for the agent socket, or already delivered into the transcript.
    await expect.poll(async () => {
      const pending = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_pending_prompt'));
      if (pending === 'Find the most liquid calls expiring within 30 days') return true;
      return (await page.locator('.ai-msg.ai-user').filter({ hasText: 'Find the most liquid calls expiring within 30 days' }).count()) > 0;
    }).toBe(true);
  });

  test('timeline posts show author identity and a view-full-chat affordance', async ({ page }) => {
    // 1×1 PNG so the user-bubble <img> loads without hitting the Worker.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.route('**/api/avatars/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    await page.route('**/api/timeline**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            share_id: 'TestShareId000000000000001',
            url: '/share/TestShareId000000000000001',
            title: 'Should I buy SPY calls',
            excerpt: 'Liquidity looks thin.',
            messages: [
              { role: 'user', content: 'Should I buy SPY calls' },
              { role: 'assistant', content: 'Liquidity looks thin across the near-dated SPY call board.' },
            ],
            handle: 'thelobster',
            name: 'Robert Lancer',
            avatar_url: '/api/avatars/user-1?v=1',
            published_at: Date.now(),
            model: 'deepseek/deepseek-v4-flash-0731',
            has_sql: true,
            has_chart: false,
          }],
          next_before: null,
          profile: null,
        }),
      });
    });

    await page.goto('/');
    const post = page.getByRole('article', { name: 'Should I buy SPY calls' });
    await expect(post).toBeVisible();
    // Name/@handle on one line over the user bubble; photo on the right.
    await expect(post.getByRole('link', { name: /Robert Lancer\s*@thelobster/ })).toBeVisible();
    const userFace = post.getByRole('link', { name: 'Robert Lancer (@thelobster)' });
    await expect(userFace).toBeVisible();
    await expect(userFace.locator('img.timeline-author-avatar')).toBeVisible();
    await expect(post.getByText('SQL')).toBeVisible();
    await expect(post.getByText('deepseek-v4-flash')).toBeVisible();
    // Title matches the user bubble — don't duplicate it as a heading.
    await expect(post.getByRole('heading', { name: 'Should I buy SPY calls' })).toHaveCount(0);
    await expect(post.getByRole('link', { name: 'View full chat' })).toBeVisible();
    // Admin-only moderation control — anonymous visitors must not see it.
    await expect(post.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
  });

  test('ask composer collapses to a chip after scrolling the feed', async ({ page }) => {
    await page.route('**/api/timeline**', async (route) => {
      const items = Array.from({ length: 8 }, (_, index) => ({
        share_id: `TestShareId0000000000000${index}`,
        url: `/share/TestShareId0000000000000${index}`,
        title: `Question ${index}`,
        excerpt: 'A'.repeat(400),
        messages: [
          { role: 'user', content: `Question ${index}` },
          { role: 'assistant', content: `${'Long answer paragraph. '.repeat(20)}` },
        ],
        handle: 'thelobster',
        name: 'Robert Lancer',
        published_at: Date.now() - index * 60_000,
        model: null,
        has_sql: false,
        has_chart: false,
      }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, next_before: null, profile: null }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const composer = page.getByRole('region', { name: 'Ask the Lobster' });
    await expect(composer.getByRole('textbox', { name: 'Message input' })).toBeVisible();

    await page.evaluate(() => {
      const sentinel = document.querySelector('.timeline-composer-sentinel');
      let current = sentinel?.parentElement ?? null;
      while (current) {
        const overflowY = getComputedStyle(current).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
          current.scrollTop += 1200;
          return;
        }
        current = current.parentElement;
      }
      window.scrollBy(0, 1200);
    });
    await expect(composer).toHaveAttribute('data-collapsed', 'true');
    await expect(composer.getByRole('button', { name: 'Ask the Lobster' })).toBeVisible();
    await expect(composer.getByRole('textbox', { name: 'Message input' })).toHaveCount(0);

    await composer.getByRole('button', { name: 'Ask the Lobster' }).click();
    await expect(composer).not.toHaveAttribute('data-collapsed', 'true');
    await expect(composer.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });


  test('GET /api/timeline is public and returns a feed envelope', async ({ request }) => {
    const res = await request.get(`${LOCAL_WORKER}/api/timeline`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control'] ?? '').toMatch(/no-store|private/i);
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

  test('profile page shows identity and public chats for a handle', async ({ page }) => {
    await page.route('**/api/timeline**', async (route) => {
      const url = new URL(route.request().url());
      const handle = url.searchParams.get('handle');
      if (handle !== 'thelobster') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'not found' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            share_id: 'TestShareId000000000000001',
            url: '/share/TestShareId000000000000001',
            title: 'Should I buy SPY calls',
            excerpt: 'Liquidity looks thin.',
            messages: [
              { role: 'user', content: 'Should I buy SPY calls' },
              { role: 'assistant', content: 'Liquidity looks thin across the near-dated SPY call board.' },
            ],
            handle: 'thelobster',
            name: 'Robert Lancer',
            published_at: Date.now(),
            model: 'deepseek/deepseek-v4-flash-0731',
            has_sql: true,
            has_chart: false,
            is_bot: false,
          }],
          next_before: null,
          profile: {
            handle: 'thelobster',
            name: 'Robert Lancer',
            is_bot: false,
            created_at: Date.UTC(2026, 0, 15),
          },
        }),
      });
    });

    await page.goto('/u/thelobster');
    await expect(page.getByRole('heading', { name: 'Robert Lancer' })).toBeVisible();
    await expect(page.getByText('@thelobster')).toBeVisible();
    await expect(page.getByText('Joined')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Public chats' })).toBeVisible();
    const post = page.getByRole('article', { name: 'Should I buy SPY calls' });
    await expect(post).toBeVisible();
    // Author byline is redundant on the profile page.
    await expect(post.getByRole('link', { name: '@thelobster' })).toHaveCount(0);
    await expect(post.getByRole('link', { name: 'View full chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'All posts' })).toBeVisible();
  });

  test('unknown profile handle shows not found', async ({ page }) => {
    await page.route('**/api/timeline**', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not found' }),
      });
    });

    await page.goto('/u/nobodyhere');
    await expect(page.getByRole('heading', { name: 'Profile not found' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to timeline' })).toBeVisible();
  });
});
