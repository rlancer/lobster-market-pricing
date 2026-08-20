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
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
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
    // Identity lives once in the byline — no second avatar on user bubbles.
    const author = post.getByRole('link', { name: /Robert Lancer\s*@thelobster/ });
    await expect(author).toBeVisible();
    await expect(author.locator('img.timeline-author-avatar')).toBeVisible();
    await expect(post.locator('.timeline-msgs .timeline-author-avatar')).toHaveCount(0);
    await expect(post.getByText('SQL')).toBeVisible();
    await expect(post.getByText('deepseek-v4-flash')).toBeVisible();
    // Title matches the user bubble — don't duplicate it as a heading.
    await expect(post.getByRole('heading', { name: 'Should I buy SPY calls' })).toHaveCount(0);
    // Full conversation stays on the timeline — no route hop to /share.
    await expect(post.getByRole('link', { name: 'View full chat' })).toHaveCount(0);
    await expect(post.getByLabel('Conversation')).toContainText('Liquidity looks thin across the near-dated SPY call board.');
    // Share control is always available even when the title is hidden.
    await expect(post.getByRole('button', { name: 'Share post' })).toBeVisible();
    // Admin-only moderation control — anonymous visitors must not see it.
    await expect(post.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
  });

  test('timeline title opens the share page and share menu offers Copy link / Share via', async ({ page }) => {
    await page.addInitScript(() => {
      // Headless Chromium often lacks Web Share — stub it so Share via… appears.
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async () => undefined,
      });
    });
    await page.route('**/api/avatars/**', async (route) => {
      await route.fulfill({ status: 204 });
    });
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            share_id: 'TestShareId000000000000042',
            url: '/share/TestShareId000000000000042',
            title: 'SPY call setup',
            excerpt: 'First answer.',
            messages: [
              { role: 'user', content: 'How is SPY looking?' },
              { role: 'assistant', content: 'Near-dated call liquidity is thin.' },
            ],
            handle: 'thelobster',
            name: 'Robert Lancer',
            published_at: Date.now(),
            model: null,
            has_sql: false,
            has_chart: false,
          }],
          next_before: null,
          profile: null,
        }),
      });
    });
    await page.route('**/api/share/TestShareId000000000000042', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          share_id: 'TestShareId000000000000042',
          title: 'SPY call setup',
          mode: 'funded',
          created_at: Date.now(),
          model: null,
          source_sql: null,
          on_timeline: true,
          messages: [
            { role: 'user', content: 'How is SPY looking?' },
            { role: 'assistant', content: 'Near-dated call liquidity is thin.' },
          ],
          author: { handle: 'thelobster', name: 'Robert Lancer' },
        }),
      });
    });

    await page.goto('/');
    const post = page.getByRole('article', { name: 'SPY call setup' });
    await expect(post).toBeVisible();
    const title = post.getByRole('heading', { name: 'SPY call setup' }).getByRole('link');
    await expect(title).toHaveAttribute('href', '/share/TestShareId000000000000042');
    // Share sits on the title row, not down in the meta footer.
    await expect(post.locator('.timeline-post-head').getByRole('button', { name: 'Share post' })).toBeVisible();

    await post.getByRole('button', { name: 'Share post' }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Share via…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Share on X' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await title.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/share/TestShareId000000000000042');
    await expect(page.getByRole('heading', { name: 'SPY call setup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share post' })).toBeVisible();
  });

  test('timeline posts expand the full conversation in place', async ({ page }) => {
    await page.route('**/api/avatars/**', async (route) => {
      await route.fulfill({ status: 204 });
    });
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            share_id: 'TestShareId000000000000099',
            url: '/share/TestShareId000000000000099',
            title: 'SPY liquidity thread',
            excerpt: 'First answer.',
            messages: [
              { role: 'user', content: 'How is SPY looking?' },
              { role: 'assistant', content: `${'Near-dated call liquidity is thin. '.repeat(24)}` },
              { role: 'user', content: 'What about puts?' },
              { role: 'assistant', content: 'Put side is deeper into next week.' },
            ],
            handle: 'thelobster',
            name: 'Robert Lancer',
            published_at: Date.now(),
            model: null,
            has_sql: false,
            has_chart: false,
          }],
          next_before: null,
          profile: null,
        }),
      });
    });

    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto('/');
    const post = page.getByRole('article', { name: 'SPY liquidity thread' });
    await expect(post).toBeVisible();
    await expect(post.getByRole('heading', { name: 'SPY liquidity thread' })).toBeVisible();
    await expect(
      post.getByRole('heading', { name: 'SPY liquidity thread' }).getByRole('link'),
    ).toHaveAttribute('href', '/share/TestShareId000000000000099');
    await expect(post.getByRole('button', { name: 'Share post' })).toBeVisible();
    await expect(post.getByLabel('Conversation')).toContainText('How is SPY looking?');
    await expect(post.getByLabel('Conversation')).toContainText('What about puts?');
    await expect(post.getByLabel('Conversation')).toContainText('Put side is deeper into next week.');
    // Tall threads clamp with an in-place Show more — never leave the feed.
    const showMore = post.getByRole('button', { name: 'Show more' });
    await expect(showMore).toBeVisible();
    await showMore.click();
    await expect(post.getByRole('button', { name: 'Show less' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });

  test('ask composer collapses to a chip after scrolling the feed', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
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

  test('desktop timeline shows a rail with tags, breaking news, and market highlights', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], next_before: null, profile: null }),
      });
    });
    await page.route((url) => url.pathname === '/api/timeline/rail', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tags: [{ ticker: 'SPY', posts: 4 }, { ticker: 'NVDA', posts: 2 }],
          news: [{
            title: 'Markets open mixed',
            link: 'https://example.com/breaking',
            published: null,
            snippet: 'Futures firmer into the open.',
            source: 'tavily',
          }],
          highlights: [
            { ticker: 'SPY', name: 'S&P 500', spot: 500.12, change_1d_pct: 0.4 },
            { ticker: 'QQQ', name: 'Nasdaq-100', spot: 440.5, change_1d_pct: -0.2 },
          ],
          fetched_at: '2026-08-19T00:00:00.000Z',
        }),
      });
    });

    await page.goto('/');
    const rail = page.getByRole('complementary', { name: 'Market rail' });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('heading', { name: 'Tags' })).toBeVisible();
    await expect(rail.getByRole('link', { name: /SPY/ })).toBeVisible();
    await expect(rail.getByRole('list', { name: 'Breaking news' })).toBeVisible();
    await expect(rail.getByText('Markets open mixed')).toBeVisible();
    await expect(rail.getByRole('list', { name: 'Market highlights' })).toBeVisible();
    await expect(rail.getByText('S&P 500')).toBeVisible();
    await expect(rail.getByText('+0.4%')).toBeVisible();
  });

  test('timeline rail is hidden on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], next_before: null, profile: null }),
      });
    });
    await page.route((url) => url.pathname === '/api/timeline/rail', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tags: [], news: [], highlights: [], fetched_at: '2026-08-19T00:00:00.000Z' }),
      });
    });

    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Ask the Lobster' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Market rail' })).toHaveCount(0);
  });


  test('GET /api/timeline/rail is public and returns a rail envelope', async ({ request }) => {
    const res = await request.get(`${LOCAL_WORKER}/api/timeline/rail`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      tags: unknown[];
      news: unknown[];
      highlights: unknown[];
      fetched_at: string;
    };
    expect(Array.isArray(body.tags)).toBe(true);
    expect(Array.isArray(body.news)).toBe(true);
    expect(Array.isArray(body.highlights)).toBe(true);
    expect(typeof body.fetched_at).toBe('string');
  });

  test('desktop chat shows a companion rail scoped to the conversation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route((url) => /\/api\/chats\/[^/]+\/tickers$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat_id: '11111111-1111-4111-8111-111111111111',
          items: [{
            chat_id: '11111111-1111-4111-8111-111111111111',
            security_id: 'sec-nvda',
            ticker: 'NVDA',
            first_seen_at: 1,
            last_seen_at: 2,
            mention_count: 2,
            name: 'NVIDIA',
          }],
        }),
      });
    });
    await page.route((url) => /\/api\/chats\/[^/]+\/rail$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat_id: '11111111-1111-4111-8111-111111111111',
          tags: [{ ticker: 'NVDA', posts: 2 }],
          news: [{
            title: 'NVDA chips bid',
            link: 'https://example.com/nvda',
            published: null,
            snippet: 'Semiconductor strength.',
            source: 'tavily',
          }],
          highlights: [
            { ticker: 'NVDA', name: 'NVIDIA', spot: 120.5, change_1d_pct: 1.5 },
          ],
          fetched_at: '2026-08-20T00:00:00.000Z',
        }),
      });
    });

    await page.goto('/chat');
    const head = page.getByRole('banner', { name: 'Chat controls' });
    const rail = page.getByRole('complementary', { name: 'Chat rail' });
    await expect(rail).toBeVisible();
    await expect(head).toBeVisible();
    // Top bar is full-bleed chrome — it spans across the rail, not just the
    // transcript column.
    const headBox = await head.boundingBox();
    const railBox = await rail.boundingBox();
    const chatBox = await page.locator('section.ai-chat').boundingBox();
    expect(headBox && railBox && chatBox).toBeTruthy();
    expect(railBox!.y).toBeGreaterThan(headBox!.y + headBox!.height - 2);
    expect(Math.abs(headBox!.width - chatBox!.width)).toBeLessThan(2);
    expect(headBox!.x + headBox!.width).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 2);

    await expect(rail.getByRole('heading', { name: 'Sources' })).toBeVisible();
    await expect(rail.getByRole('link', { name: /NVDA/ })).toBeVisible();
    // Sources live in the rail on desktop — not above the transcript.
    await expect(page.locator('.ai-chat-main .chat-research')).toHaveCount(0);
    await expect(rail.getByRole('list', { name: 'Related news' })).toBeVisible();
    await expect(rail.getByText('NVDA chips bid')).toBeVisible();
    await expect(rail.getByRole('list', { name: 'Session tape' })).toBeVisible();
    await expect(rail.getByText('NVIDIA')).toBeVisible();
    await expect(rail.getByText('+1.5%')).toBeVisible();
  });

  test('chat rail stays hidden on an empty welcome chat', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.route((url) => /\/api\/chats\/[^/]+\/tickers$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chat_id: '11111111-1111-4111-8111-111111111111', items: [] }),
      });
    });
    await page.route((url) => /\/api\/chats\/[^/]+\/rail$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat_id: '11111111-1111-4111-8111-111111111111',
          tags: [],
          news: [{ title: 'Markets open', link: 'https://example.com/m', published: null, snippet: '', source: 'tavily' }],
          highlights: [{ ticker: 'SPY', name: 'S&P 500', spot: 500, change_1d_pct: 0.1 }],
          fetched_at: '2026-08-20T00:00:00.000Z',
        }),
      });
    });

    await page.goto('/chat');
    await expect(page.getByRole('heading', { name: 'Ask the Lobster' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Chat rail' })).toHaveCount(0);
  });

  test('chat rail is hidden on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route((url) => /\/api\/chats\/[^/]+\/tickers$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat_id: '11111111-1111-4111-8111-111111111111',
          items: [{
            chat_id: '11111111-1111-4111-8111-111111111111',
            security_id: 'sec-nvda',
            ticker: 'NVDA',
            first_seen_at: 1,
            last_seen_at: 2,
            mention_count: 1,
          }],
        }),
      });
    });
    await page.route((url) => /\/api\/chats\/[^/]+\/rail$/.test(url.pathname), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chat_id: '11111111-1111-4111-8111-111111111111',
          tags: [{ ticker: 'NVDA', posts: 1 }],
          news: [],
          highlights: [],
          fetched_at: '2026-08-20T00:00:00.000Z',
        }),
      });
    });

    await page.goto('/chat');
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Chat rail' })).toHaveCount(0);
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
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
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
    await expect(post.getByRole('link', { name: 'View full chat' })).toHaveCount(0);
    await expect(post.getByLabel('Conversation')).toContainText('Liquidity looks thin');
    await expect(page.getByRole('button', { name: 'All posts' })).toBeVisible();
  });

  test('bot profile header ranks persona above bio in one meta line', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('handle') !== 'nowlobster') {
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
          items: [],
          next_before: null,
          profile: {
            handle: 'nowlobster',
            name: 'Now Lobster',
            is_bot: true,
            persona: "What's happening now",
            bio: 'Live desk commentary on the session.',
            created_at: Date.UTC(2026, 0, 15),
          },
        }),
      });
    });

    await page.goto('/u/nowlobster');
    const header = page.locator('header.profile-header');
    await expect(header.getByRole('heading', { name: 'Now Lobster' })).toBeVisible();
    await expect(header.getByText('@nowlobster')).toBeVisible();
    await expect(header.getByText('bot', { exact: true })).toBeVisible();
    await expect(header.getByText('Joined')).toBeVisible();
    await expect(header.getByText("What's happening now")).toBeVisible();
    await expect(header.getByText('Live desk commentary on the session.')).toBeVisible();

    // Meta stays one scan line; persona sits above bio as the tagline.
    const metaBox = await header.locator('.profile-meta').boundingBox();
    const personaBox = await header.locator('.profile-persona').boundingBox();
    const bioBox = await header.locator('.profile-bio').boundingBox();
    expect(metaBox && personaBox && bioBox).toBeTruthy();
    expect(metaBox!.y).toBeLessThan(personaBox!.y);
    expect(personaBox!.y).toBeLessThan(bioBox!.y);
    expect(Math.abs(metaBox!.y - (await header.getByText('Joined').boundingBox())!.y)).toBeLessThan(8);
  });

  test('unknown profile handle shows not found', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/timeline', async (route) => {
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
