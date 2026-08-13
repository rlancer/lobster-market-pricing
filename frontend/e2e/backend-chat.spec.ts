import { expect, test, type Page } from '@playwright/test';

const READY = process.env.COPILOT_E2E_READY === '1';
const LOCAL_WORKER = 'http://127.0.0.1:8787';

async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.fill(question);
  await page.keyboard.press('Enter');
}

async function lastAnswer(page: Page, busyTimeout = 300_000): Promise<string> {
  await expect(page.locator('.ai-busy')).toBeHidden({ timeout: busyTimeout });
  const error = page.locator('.ai-msg.ai-assistant .ai-err').last();
  if (await error.count()) throw new Error(`Copilot failed: ${(await error.innerText()).trim()}`);
  const answer = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  await expect(answer).toBeAttached();
  const text = (await answer.innerText()).trim();
  expect(text.length).toBeGreaterThan(20);
  return text;
}

test.describe('Server-funded Copilot Agent', () => {
  test('uses the Agent WebSocket and receives progress, prose, and SQL', async ({ page }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    const websocketUrls: string[] = [];
    const oldChatRequests: string[] = [];
    const browserAuthorizationHeaders: string[] = [];
    page.on('websocket', (socket) => websocketUrls.push(socket.url()));
    page.on('request', (request) => {
      if (request.url().endsWith('/api/chat') && request.method() === 'POST') oldChatRequests.push(request.url());
      const authorization = request.headers().authorization;
      if (authorization) browserAuthorizationHeaders.push(authorization);
    });

    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(0);
    const storedAiPreferences = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('openinterest_ai_')));
    expect(storedAiPreferences).toEqual([]);
    const chatId = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'));
    expect(chatId).toMatch(/^[0-9a-f-]{36}$/);

    await ask(page, 'Which sector has the most open interest across all expirations? Give a concise answer.');
    await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ai-tool-row').first()).toBeVisible({ timeout: 180_000 });
    const answer = await lastAnswer(page);

    expect(answer.length).toBeGreaterThan(20);
    await expect(page.locator('.ai-sql').last()).toBeVisible();
    expect(websocketUrls.some((url) => url.includes(`/agents/copilot-agent/${chatId}`))).toBe(true);
    expect(oldChatRequests).toEqual([]);
    expect(browserAuthorizationHeaders).toEqual([]);
  });

  test('chart request renders a plot from the query result', async ({ page }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    test.setTimeout(600_000);
    await page.goto('/');
    await ask(page, 'Chart the IV smile for NVDA');
    await lastAnswer(page, 540_000);
    await expect(page.locator('.ai-chart').last()).toBeVisible();
    await expect(page.locator('.ai-chart .recharts-wrapper, .ai-chart svg').last()).toBeVisible();
  });

  test('oversized question is rejected before a model answer', async ({ page }) => {
    await page.goto('/');
    await ask(page, 'x'.repeat(4_001));
    await expect(page.locator('.ai-msg.ai-assistant .ai-err').last()).toContainText('question exceeds 4000 characters', { timeout: 30_000 });
    await expect(page.locator('.ai-sql')).toHaveCount(0);
  });

  test('legacy chat and resume routes are removed', async ({ request }) => {
    const oldChat = await request.post(`${LOCAL_WORKER}/api/chat`, {
      data: { question: 'hello', chat_id: crypto.randomUUID(), history: [] },
    });
    expect(oldChat.status()).toBe(404);
    const oldResume = await request.get(`${LOCAL_WORKER}/api/chat/result?chat_id=${crypto.randomUUID()}`);
    expect(oldResume.status()).toBe(404);
  });
});
