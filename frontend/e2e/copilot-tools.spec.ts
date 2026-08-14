import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Copilot tool-usage e2e: prove the Worker-side AI loop fires news,
// web_search, and eco_calendar and grounds the answer in their outputs. The
// standard AI SDK tool parts rendered in the progress feed are the
// deterministic signal that a tool ran; direct endpoint reads provide source material.
//
// The chat questions below deliberately NEVER name a tool ("get_news",
// "web_search", "eco_calendar"): a real user asks "why is it moving?" or
// "what are analysts saying?" and the systemPrompt Enrichment block has to
// route intent → tool on its own. Naming the tool in the prompt would make
// the test a tautology; the fuzzy phrasing is what verifies prompt-driven
// routing actually works. The waitForResponse cap on the exact endpoint is
// still deterministic proof the right tool ran.
//
// Live-model checks require OPEN_ROUTER_KEY in worker/.dev.vars. The browser
// never receives it; playwright.config.ts exposes only a presence flag.
// ---------------------------------------------------------------------------

const READY = process.env.COPILOT_E2E_READY === '1';
const LOCAL_WORKER = 'http://127.0.0.1:8787';

async function openChat(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/i);
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
  // Busy spinner renders while the agent loop runs; auto-routed models can
  // churn through several tool iterations, so the completion budget is
  // generous (override per test when needed).
  await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ai-busy')).toBeHidden({ timeout: busyTimeout });
  const err = page.locator('.ai-msg.ai-assistant .ai-err').last();
  if (await err.count()) {
    throw new Error(`Copilot returned an error instead of an answer: ${(await err.innerText()).trim()}`);
  }
  const bubble = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  if (!(await bubble.count())) {
    // Bubble rendered with only metadata (timestamp/model) — the model ended
    // its turn with an empty final message. Retry (config retries:1) handles it.
    throw new Error('Copilot finished with an empty answer (model returned no content).');
  }
  await expect(bubble).toBeAttached();
  const text = (await bubble.innerText()).trim();
  expect(text.length).toBeGreaterThan(60);
  return text;
}

// Common noise words that don't prove grounding in fetched headlines.
const STOP = new Set([
  'about', 'after', 'against', 'ahead', 'amid', 'analysts', 'and', 'are', 'been',
  'before', 'but', 'com', 'for', 'from', 'has', 'have', 'into', 'its', 'latest',
  'may', 'new', 'news', 'not', 'on', 'out', 'over', 'said', 'says', 'stock',
  'stocks', 'that', 'the', 'their', 'this', 'today', 'was', 'what', 'why', 'with', 'you',
]);

/**
 * How many distinctive words from the fetched tool payload (headline/search
 * titles + snippets) appear in the last answer. Models paraphrase titles but
 * summarize snippet content, so matching against both keeps the check robust
 * while still proving the answer is grounded in the tool's output rather than
 * training-data priors.
 */
async function contentOverlap(page: Page, items: { title?: string; snippet?: string }[]): Promise<number> {
  const text = (await page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last().innerText()).toLowerCase();
  const tokens = new Set(
    items.flatMap((i) => `${i.title ?? ''} ${i.snippet ?? ''}`.toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
  return [...tokens].filter((w) => text.includes(w)).length;
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

  test('routes a per-ticker "why is it moving" question to get_news and cites headline links', async ({ page, request }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    test.setTimeout(600_000);
    const source = await request.get(`${LOCAL_WORKER}/api/news?symbol=NVDA&limit=8`);
    const payload = (await source.json()) as { items: { title?: string; snippet?: string }[] };
    expect(payload.items.length).toBeGreaterThan(0);
    await openChat(page);

    await ask(page, 'Why is NVDA moving a lot today? What do the headlines say?');
    await expect(page.locator('.ai-tool-name').filter({ hasText: 'News' })).toBeVisible({ timeout: 200_000 });
    const text = await lastAnswer(page, 540_000);
    expect(text.toLowerCase()).toContain('nvda');
    expect(await contentOverlap(page, payload.items), 'answer should reflect fetched headlines').toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'test-results/chat-news.png', fullPage: true });
  });

  test('routes an analyst-commentary question to web_search and cites links', async ({ page, request }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    test.setTimeout(600_000);
    const source = await request.get(`${LOCAL_WORKER}/api/web_search?q=AI+chip+makers+analyst+commentary&limit=5`);
    const payload = (await source.json()) as { results: { title?: string; snippet?: string }[] };
    expect(payload.results.length).toBeGreaterThan(0);
    await openChat(page);

    await ask(page, 'What are analysts saying about AI chip makers lately? Any fresh commentary worth knowing?');
    await expect(page.locator('.ai-tool-name').filter({ hasText: 'Web search' })).toBeVisible({ timeout: 200_000 });
    const text = await lastAnswer(page, 540_000);
    expect(text.length).toBeGreaterThan(60);
    expect(await contentOverlap(page, payload.results), 'answer should reflect fetched search results').toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'test-results/chat-web-search.png' });
  });

  test('routes a "what is coming up" vol question to eco_calendar', async ({ page, request }) => {
    test.skip(!READY, 'No OPEN_ROUTER_KEY in worker/.dev.vars');
    test.setTimeout(600_000);
    const source = await request.get(`${LOCAL_WORKER}/api/econ_calendar`);
    const payload = (await source.json()) as { items: unknown[] };
    expect(payload.items.length).toBeGreaterThan(0);
    await openChat(page);

    await ask(page, 'Is a Fed meeting or a big macro report coming up soon that could move vol?');
    await expect(page.locator('.ai-tool-name').filter({ hasText: 'Eco calendar' })).toBeVisible({ timeout: 200_000 });
    const text = await lastAnswer(page, 540_000);
    const dateRe = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2}/i;
    expect(text).toMatch(dateRe);
    await page.screenshot({ path: 'test-results/chat-econ-calendar.png' });
  });
});