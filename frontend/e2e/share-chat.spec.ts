import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Share-chat e2e: turn a real chat conversation into a public unlisted
// link and read it back exactly as a recipient would.
//   - Before any user message the Share button is disabled (aria-disabled).
//   - After the first user message is submitted, Share enables (answer not
//     required). Share → dialog shows the copyable URL; "View share"
//     navigates to /share/:shareId, where the transcript renders
//     read-only (user + assistant bubbles, SQL block) with NO key loaded.
//   - The recipient API (GET /api/share/:id) works keyless and never leaks
//     the server-side abuse columns (ip / user_agent).
//   - Share pages render inside the workspace shell (SideNav / mobile bottom
//     nav + drawer) so recipients can navigate to Timeline, Chat, etc.
// Live-model checks require OPEN_ROUTER_KEY in worker/.dev.vars. The browser
// never receives it; playwright.config.ts exposes only a presence flag.
// ---------------------------------------------------------------------------

const READY = process.env.COPILOT_E2E_READY === '1';
const LOCAL_WORKER = 'http://127.0.0.1:8787';

async function openChat(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
  await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
}

/** Type a question into the composer and submit with Enter. */
async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByRole('textbox');
  await composer.click();
  await page.keyboard.type(question, { delay: 15 });
  await page.keyboard.press('Enter');
}

/** Wait for the busy indicator to come and go, then return the last answer text. */
async function lastAnswer(page: Page, busyTimeout = 280_000): Promise<string> {
  await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ai-busy')).toBeHidden({ timeout: busyTimeout });
  const err = page.locator('.ai-msg.ai-assistant .ai-err').last();
  if (await err.count()) {
    throw new Error(`Chat returned an error instead of an answer: ${(await err.innerText()).trim()}`);
  }
  const bubble = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  await expect(bubble).toBeAttached();
  const text = (await bubble.innerText()).trim();
  expect(text.length).toBeGreaterThan(10);
  return text;
}

test.describe('Share chat (public unlisted transcripts)', () => {
  const SHARE_ID = 'TestShareId000000000000Chrome';

  async function mockShare(page: Page): Promise<void> {
    await page.route(`**/api/share/${SHARE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          share_id: SHARE_ID,
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
  }

  test('share page uses workspace chrome on desktop', async ({ page }) => {
    await mockShare(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/share/${SHARE_ID}`);

    await expect(page.getByRole('heading', { name: 'SPY call setup' })).toBeVisible();
    await expect(page.locator('.workspace-nav')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Floor' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chat', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toHaveCount(0);

    await page.getByRole('link', { name: 'Floor' }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });

  test('share page uses workspace chrome on mobile', async ({ page }) => {
    await mockShare(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/share/${SHARE_ID}`);

    await expect(page.getByRole('heading', { name: 'SPY call setup' })).toBeVisible();

    const bottomNav = page.getByRole('navigation', { name: 'Mobile navigation' });
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Floor' })).toBeVisible();
    await expect(bottomNav.getByRole('link', { name: 'Floor' })).toHaveAttribute('aria-current', 'page');
    await expect(bottomNav.getByRole('button', { name: 'Menu' })).toBeVisible();
    await expect(bottomNav.getByRole('button', { name: 'New chat' })).toBeVisible();

    await bottomNav.getByTestId('mobile-nav-toggle').click();
    const drawer = page.locator('dialog[aria-label="Navigation"]');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Floor' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();

    await drawer.getByRole('link', { name: 'Floor' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  });

  test('share button → dialog → read-only /share/:id page', async ({ page, request }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');

    // Fresh chat: the Share button exists but is disabled until a user message.
    await openChat(page);
    const shareBtn = page.getByRole('button', { name: 'Share chat' });
    await expect(shareBtn).toBeVisible();
    // Astryx IconButton signals disabled via aria-disabled, not the attribute.
    await expect(shareBtn).toHaveAttribute('aria-disabled', 'true');

    // First submitted user message → Share enables (does not wait for the answer).
    await ask(page, 'Which sector has the most open interest? Answer in one line.');
    await expect(shareBtn).not.toHaveAttribute('aria-disabled', 'true');
    const text = await lastAnswer(page, 300_000);
    await expect(shareBtn).not.toHaveAttribute('aria-disabled', 'true');

    // Share → dialog reveals the public URL.
    await shareBtn.click();
    const urlInput = page.locator('#ai-share-url');
    await expect(urlInput).toBeVisible({ timeout: 30_000 });
    const shareUrl = await urlInput.inputValue();
    const shareId = shareUrl.split('/').pop() ?? '';
    expect(shareId).toMatch(/^[0-9A-Za-z]{10,}$/);

    await expect(page.getByRole('switch', { name: 'Post to the Floor' })).toBeVisible();

    // "View share" navigates to the public page — exactly what a recipient sees.
    await page.getByRole('button', { name: 'View share' }).click();
    await page.waitForURL(/\/share\//);
    await expect(page.locator('.share-msgs .ai-msg')).toHaveCount(2);
    await expect(page.locator('.share-msgs')).toContainText(text.slice(0, 40));
    // SQL block is part of the transcript (the assistant ran a query).
    await expect(page.locator('.share-msgs .ai-sql pre')).toHaveCount(1);
    await expect(page.locator('.share-msgs .ai-result')).toBeVisible({ timeout: 30_000 });

    // Recipient API: keyless GET returns the transcript and NEVER the
    // server-side abuse columns.
    const res = await request.get(`${LOCAL_WORKER}/api/share/${shareId}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      ip?: unknown;
      user_agent?: unknown;
      source_sql?: string | null;
      messages: unknown[];
    };
    expect(body.mode).toBe('funded');
    expect(body.ip).toBeUndefined();
    expect(body.user_agent).toBeUndefined();
    expect(body.messages.length).toBeGreaterThanOrEqual(2);
    expect(typeof body.source_sql).toBe('string');
  });
});
