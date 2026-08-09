import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Copilot tool-usage e2e: prove the AI chat actually fires the news /
// web_search / eco_calendar tools (proxied by the local worker) and cites the
// results. The deterministic signal is the worker request each tool makes —
// captured via waitForResponse — plus the assistant's final answer carrying a
// citable source link (news/web_search) or event date (eco_calendar).
//
// Requires an OpenRouter key: process.env.OPENROUTER_API_KEY or the root
// `.env` OPEN_ROUTER_LOCAL_DEV_KEY (see playwright.config.ts). Chat tests skip
// (not fail) without one so CI without a key stays green.
// ---------------------------------------------------------------------------

const KEY = process.env.OPENROUTER_API_KEY ?? '';
const LOCAL_WORKER = 'http://127.0.0.1:8787';

/** Open the chat with the OpenRouter key pre-seeded (BYOK localStorage). */
async function openChat(page: Page): Promise<void> {
  await page.addInitScript((k: string) => {
    localStorage.setItem('openinterest_ai_key', k);
    // Default model is openrouter/auto when unset — leave it unset.
  }, KEY);
  await page.goto('/');
  // Key indicator goes green once the app sees the stored key.
  await expect(page.locator('.ai-key-dot.ok')).toBeVisible();
}

/** Type a question into the composer and submit with Enter. */
async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByRole('textbox');
  await composer.click();
  await page.keyboard.type(question, { delay: 15 });
  await page.keyboard.press('Enter');
}

/** Wait for the busy indicator to come and go, then return the last answer text. */
async function lastAnswer(page: Page): Promise<string> {
  // Busy spinner renders while the agent loop runs.
  await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ai-busy')).toBeHidden({ timeout: 280_000 });
  const bubble = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  await expect(bubble).toBeAttached();
  const text = (await bubble.innerText()).trim();
  expect(text.length).toBeGreaterThan(60);
  return text;
}

/** Number of clickable source links in the last assistant answer. */
async function answerLinks(page: Page): Promise<number> {
  return page.locator('.ai-msg.ai-assistant .ai-bubble a[href^="http"]').count();
}

test.describe('Copilot tool usage (chat → worker → upstream)', () => {
  test('worker endpoints respond (backend sanity, no LLM)', async ({ request }) => {
    for (const [name, url, body] of [
      ['news', `${LOCAL_WORKER}/api/news?symbol=NVDA&limit=3`, 'items'],
      ['web_search', `${LOCAL_WORKER}/api/web_search?q=nvda+analyst+commentary&limit=3`, 'results'],
      ['econ_calendar', `${LOCAL_WORKER}/api/econ_calendar`, 'items'],
    ] as const) {
      const res = await request.get(url);
      expect(res.status(), `${name} status`).toBe(200);
      const j = (await res.json()) as Record<string, unknown> & { error?: string };
      expect(j.error, `${name} error`).toBeUndefined();
      expect((j[body] as unknown[]).length, `${name} payload`).toBeGreaterThan(0);
    }
  });

  test('chat uses get_news for a ticker and cites headline links', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    await openChat(page);

    const newsResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/news`) && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'Why is NVDA moving? Call get_news for NVDA for the latest headlines and cite the article links you use.');
    const resp = await newsResp;
    const payload = (await resp.json()) as { items: unknown[] };
    expect(payload.items.length).toBeGreaterThan(0);

    const text = await lastAnswer(page);
    expect(text.toLowerCase()).toContain('nvda');
    expect(await answerLinks(page)).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: 'test-results/chat-news.png', fullPage: true });
  });

  test('chat uses web_search for analyst commentary and cites links', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    await openChat(page);

    const searchResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/web_search`) && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'Use the web_search tool to find recent analyst commentary about NVDA, summarize it, and cite the links you find.');
    const resp = await searchResp;
    const payload = (await resp.json()) as { results: unknown[] };
    expect(payload.results.length).toBeGreaterThan(0);

    await lastAnswer(page);
    expect(await answerLinks(page)).toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: 'test-results/chat-web-search.png' });
  });

  test('chat uses eco_calendar for upcoming macro events', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    await openChat(page);

    const calResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/econ_calendar`) && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'Are there any macro events or FOMC meetings coming up? Use the eco_calendar tool and list the event dates.');
    const resp = await calResp;
    const payload = (await resp.json()) as { items: unknown[] };
    expect(payload.items.length).toBeGreaterThan(0);

    const text = await lastAnswer(page);
    // The calendar tool output carries ISO dates; the answer should echo one.
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}|(January|February|March|April|May|June|July|August|September|October|November|December)/i);
    await page.screenshot({ path: 'test-results/chat-econ-calendar.png' });
  });
});