import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Share-chat e2e: turn a real Copilot conversation into a public unlisted
// link and read it back exactly as a recipient would.
//   - Before any turn the Share button is disabled (aria-disabled).
//   - After a completed turn, Share → dialog shows the copyable URL; "View
//     share" navigates to /share/:shareId, where the transcript renders
//     read-only (user + assistant bubbles, SQL block) with NO key loaded.
//   - The recipient API (GET /api/share/:id) works keyless and never leaks
//     the server-side abuse columns (ip / user_agent).
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
    throw new Error(`Copilot returned an error instead of an answer: ${(await err.innerText()).trim()}`);
  }
  const bubble = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  await expect(bubble).toBeAttached();
  const text = (await bubble.innerText()).trim();
  expect(text.length).toBeGreaterThan(10);
  return text;
}

test.describe('Share chat (public unlisted transcripts)', () => {
  test('share button → dialog → read-only /share/:id page', async ({ page, request }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');

    // Fresh chat: the Share button exists but is disabled until a turn lands.
    await openChat(page);
    const shareBtn = page.getByRole('button', { name: 'Share chat' });
    await expect(shareBtn).toBeVisible();
    // Astryx IconButton signals disabled via aria-disabled, not the attribute.
    await expect(shareBtn).toHaveAttribute('aria-disabled', 'true');

    // One completed turn → Share becomes enabled (Astryx removes the
    // aria-disabled attribute when the button is enabled).
    await ask(page, 'Which sector has the most open interest? Answer in one line.');
    const text = await lastAnswer(page, 300_000);
    await expect(shareBtn).not.toHaveAttribute('aria-disabled', 'true');

    // Share → dialog reveals the public URL.
    await shareBtn.click();
    const urlInput = page.locator('#ai-share-url');
    await expect(urlInput).toBeVisible({ timeout: 30_000 });
    const shareUrl = await urlInput.inputValue();
    const shareId = shareUrl.split('/').pop() ?? '';
    expect(shareId).toMatch(/^[0-9A-Za-z]{10,}$/);

    await expect(page.getByRole('switch', { name: 'Post to public timeline' })).toBeVisible();

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