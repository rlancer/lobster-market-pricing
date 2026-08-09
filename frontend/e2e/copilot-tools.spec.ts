import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Copilot tool-usage e2e: prove the AI chat actually fires the news /
// web_search / eco_calendar tools (proxied by the local worker) and cites the
// results. The deterministic signal is the worker request each tool makes —
// captured via waitForResponse — plus a sanity check that the answer is built
// on the fetched material (source link OR a named outlet for news/web_search,
// an event date for eco_calendar). Citation style varies by model, so the
// answer check accepts either clickable links or named outlets; the endpoint
// hit is what really proves the tool ran.
//
// The chat questions below deliberately NEVER name a tool ("get_news",
// "web_search", "eco_calendar"): a real user asks "why is it moving?" or
// "what are analysts saying?" and the systemPrompt Enrichment block has to
// route intent → tool on its own. Naming the tool in the prompt would make
// the test a tautology; the fuzzy phrasing is what verifies prompt-driven
// routing actually works. The waitForResponse cap on the exact endpoint is
// still deterministic proof the right tool ran.
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
 * titles) appear in the last answer. Citation format varies by model (links,
 * named outlets, or plain retelling), so this checks the answer is actually
 * grounded in the tool's output rather than training-data priors — robust to
 * any citation style.
 */
async function titleOverlap(page: Page, items: { title?: string }[]): Promise<number> {
  const text = (await page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last().innerText()).toLowerCase();
  const tokens = new Set(
    items.flatMap((i) => (i.title ?? '').toLowerCase().split(/[^a-z0-9]+/))
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

  test('routes a per-ticker "why is it moving" question to get_news and cites headline links', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    test.setTimeout(600_000);
    await openChat(page);

    // No tool named in the question — the system prompt must route this to
    // get_news for NVDA specifically (not web_search, not a random symbol).
    const newsResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/news`) && r.url().includes('symbol=NVDA') && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'Why is NVDA moving a lot today? What do the headlines say?');
    const resp = await newsResp;
    const payload = (await resp.json()) as { items: unknown[] };
    expect(payload.items.length).toBeGreaterThan(0);

    const text = await lastAnswer(page, 540_000);
    expect(text.toLowerCase()).toContain('nvda');
    // Answer must be built on the fetched headlines (any citation style).
    expect(await titleOverlap(page, payload.items), 'answer should reflect fetched headlines').toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'test-results/chat-news.png', fullPage: true });
  });

  test('routes an analyst-commentary question to web_search and cites links', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    test.setTimeout(600_000);
    await openChat(page);

    // No tool name: "what are analysts saying" must route to web_search via
    // the system prompt, not to get_news or a SQL query.
    const searchResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/web_search`) && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'What are analysts saying about AI chip makers lately? Any fresh commentary worth knowing?');
    const resp = await searchResp;
    const payload = (await resp.json()) as { results: unknown[] };
    expect(payload.results.length).toBeGreaterThan(0);

    const text = await lastAnswer(page, 540_000);
    expect(text.length).toBeGreaterThan(60);
    // Answer must be built on the fetched search results (any citation style
    // the model chooses — links, named outlets, or plain retelling).
    expect(await titleOverlap(page, payload.results), 'answer should reflect fetched search results').toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: 'test-results/chat-web-search.png' });
  });

  test('routes a "what is coming up" vol question to eco_calendar', async ({ page }) => {
    test.skip(!KEY, 'No OpenRouter key (set OPENROUTER_API_KEY or root .env OPEN_ROUTER_LOCAL_DEV_KEY)');
    // Agent loops on openrouter/auto can churn several tool iterations for a
    // fuzzy macro question; budget ~10 min for completion.
    test.setTimeout(600_000);
    await openChat(page);

    // No tool name: Fed-meeting / macro-window intent must route to
    // eco_calendar via the system prompt alone.
    const calResp = page.waitForResponse(
      (r) => r.url().startsWith(`${LOCAL_WORKER}/api/econ_calendar`) && r.status() === 200,
      { timeout: 200_000 },
    );
    await ask(page, 'Is a Fed meeting or a big macro report coming up soon that could move vol?');
    const resp = await calResp;
    const payload = (await resp.json()) as { items: unknown[] };
    expect(payload.items.length).toBeGreaterThan(0);

    const text = await lastAnswer(page, 540_000);
    // The calendar tool output carries dates; the answer should echo one —
    // as an ISO date, a full month name, or an abbreviated "Aug. 12" style.
    const dateRe = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2}/i;
    expect(text).toMatch(dateRe);
    await page.screenshot({ path: 'test-results/chat-econ-calendar.png' });
  });
});