import { expect, test, type Page } from '@playwright/test';

const READY = process.env.COPILOT_E2E_READY === '1';
const LOCAL_WORKER = 'http://127.0.0.1:8787';

async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.fill(question);
  await page.keyboard.press('Enter');
}

async function lastAnswer(page: Page, busyTimeout = 300_000): Promise<string> {
  await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ai-busy')).toBeHidden({ timeout: busyTimeout });
  const error = page.locator('.ai-msg.ai-assistant .ai-err').last();
  if (await error.count()) throw new Error(`Copilot failed: ${(await error.innerText()).trim()}`);
  const answer = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  await expect(answer).toBeAttached();
  const text = (await answer.innerText()).trim();
  expect(text.length).toBeGreaterThan(20);
  return text;
}

test.describe('Server-funded Copilot', () => {
  test('browser is a thin SSE client and receives prose plus SQL', async ({ page }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    await page.goto('/');

    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    const storedAiPreferences = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('openinterest_ai_')));
    expect(storedAiPreferences).toEqual([]);

    const chatResponse = page.waitForResponse((response) => response.url() === `${LOCAL_WORKER}/api/chat` && response.request().method() === 'POST');
    await ask(page, 'Which sector has the most open interest across all expirations? Give a concise answer.');
    const response = await chatResponse;
    expect(response.status()).toBe(200);
    const sent = response.request().postDataJSON() as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['chat_id', 'history', 'question']);
    const answer = await lastAnswer(page);
    expect(answer.length).toBeGreaterThan(20);
    await expect(page.locator('.ai-sql').last()).toBeVisible();
  });

  test('rejects an oversized history payload before model spend', async ({ request }) => {
    const response = await request.post(`${LOCAL_WORKER}/api/chat`, {
      data: {
        question: 'hello',
        chat_id: crypto.randomUUID(),
        history: [{ role: 'user', content: 'x'.repeat(100_000) }],
      },
    });
    expect(response.status()).toBe(413);
  });
});
