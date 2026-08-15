import { expect, test, type Page } from '@playwright/test';

const READY = process.env.COPILOT_E2E_READY === '1';
const IS_REMOTE = Boolean(process.env.E2E_TARGET || process.env.E2E_API_URL);

async function openChat(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(question);
  await page.keyboard.press('Enter');
}

/** Wait for the rendered assistant answer text to become non-trivial in length. */
async function waitForAnswerText(page: Page, timeout = 300_000): Promise<string> {
  await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('.ai-msg.ai-assistant .ai-text');
    const last = nodes[nodes.length - 1];
    return Boolean(last && last.textContent && last.textContent.trim().length > 20);
  }, undefined, { timeout });
  const error = page.locator('.ai-msg.ai-assistant .ai-err').last();
  if (await error.count()) throw new Error(`Copilot failed: ${(await error.innerText()).trim()}`);
  return (await page.locator('.ai-msg.ai-assistant .ai-text').last().innerText()).trim();
}

test.describe('Agent reconnect and durable recovery', () => {
  // A real page reload is the genuine client-reconnect path: the reload tears
  // down the live WebSocket mid-turn, sessionStorage keeps the same chat UUID,
  // and useAgent reconnects to the SAME Agents instance (resume:true) to finish
  // the in-flight stream. This is client reconnect/resume — NOT Agent eviction
  // (chatRecovery) recovery; the true interruption proof is a supervised
  // harness Worker restart (see AGENTS docs / handoff, never relabel the two).
  test('reload reconnects to the same Agent and resumes the active turn', async ({ page }) => {
    test.skip(!READY && !IS_REMOTE, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    const websocketUrls: string[] = [];
    page.on('websocket', (socket) => websocketUrls.push(socket.url()));
    await openChat(page);
    const chatId = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'));

    await ask(page, 'Which sector has the most open interest? Answer in one concise sentence.');
    await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ai-tool-row').first()).toBeVisible({ timeout: 180_000 });

    // Reload while the turn is active — the client must reconnect to the same
    // Agent UUID and finish the in-flight turn (resume:true).
    await page.reload();
    const answer = await waitForAnswerText(page, 360_000);

    const reconnectedChatId = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'));
    expect(reconnectedChatId).toBe(chatId);
    expect(websocketUrls.filter((url) => url.includes(`/agents/copilot-agent/${chatId}`)).length).toBeGreaterThanOrEqual(2);

    // Second reload proves the completed turn was persisted and restored.
    await page.reload();
    await page.waitForFunction((prefix) => {
      const nodes = document.querySelectorAll('.ai-msg.ai-assistant .ai-text');
      const last = nodes[nodes.length - 1];
      return Boolean(last && last.textContent && last.textContent.trim().startsWith(prefix));
    }, answer.slice(0, 30), { timeout: 60_000 });
    expect(await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'))).toBe(chatId);
  });

  test('Stop pauses the turn and Start resumes it', async ({ page }) => {
    test.skip(!READY && !IS_REMOTE, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    await openChat(page);
    await ask(page, 'Which sector has the most open interest? Answer in one concise sentence.');
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Stop generating' }).click();
    await expect(page.getByRole('button', { name: 'Start generating' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Paused — start to resume')).toBeVisible();
    await page.getByRole('button', { name: 'Start generating' }).click();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({ timeout: 30_000 });
    const answer = await waitForAnswerText(page, 360_000);
    expect(answer.length).toBeGreaterThan(20);
  });

  test('offline disconnect shows reconnecting and recovers when back online', async ({ page, context }) => {
    await openChat(page);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(page.locator('.ai-conn')).toHaveCount(0, { timeout: 30_000 });
    await context.setOffline(true);
    await expect(page.locator('.ai-conn')).toContainText(/offline|reconnect/i, { timeout: 15_000 });
    await context.setOffline(false);
    await expect(page.locator('.ai-conn')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('New Chat switches to a clean Agent instance', async ({ page }) => {
    await openChat(page);
    const oldId = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'));
    await page.getByRole('button', { name: 'New chat' }).click();
    const newId = await page.evaluate(() => sessionStorage.getItem('openinterest_copilot_chat_id'));
    expect(newId).not.toBe(oldId);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/chat');
    await expect(page.locator('.ai-msg')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Ask the Lobster' })).toBeVisible();
  });
});