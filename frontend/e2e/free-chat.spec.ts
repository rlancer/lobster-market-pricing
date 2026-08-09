import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Free anonymous Copilot chats (no OpenRouter key in the browser) funded by
// the site's OpenRouter key (Worker /api/free/*). The deterministic signal is
// the Worker's free-chat credit gate:
//   - A real chat (no key) streams an answer on the site key and shows the
//     credit chip. Skip-gated on a *funded* OPEN_ROUTER_KEY being present in
//     worker/.dev.vars (read via /api/free/quota) — same spirit as the BYOK
//     KEY gating in copilot-tools.spec.ts, so CI without a funded key stays
//     green and never drains the balance.
//   - The exhausted paths are exercised WITHOUT spending credit or needing a
//     key: Playwright route-stubs /api/free/quota → { remaining: 0 } (gate on
//     mount) and /api/free/v1/chat/completions → 402 (gate mid-chat).
// ---------------------------------------------------------------------------

const LOCAL_WORKER = 'http://127.0.0.1:8787';

interface FreeQuotaLike {
  remaining: number;
  is_free_tier: boolean;
}

async function workerFreeQuota(request: APIRequestContext): Promise<FreeQuotaLike | null> {
  try {
    const res = await request.get(`${LOCAL_WORKER}/api/free/quota`);
    if (res.status() !== 200) return null;
    return (await res.json()) as FreeQuotaLike;
  } catch {
    return null;
  }
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
    throw new Error(`Free chat returned an error instead of an answer: ${(await err.innerText()).trim()}`);
  }
  const bubble = page.locator('.ai-msg.ai-assistant .ai-bubble .ai-text').last();
  if (!(await bubble.count())) {
    throw new Error('Free chat finished with an empty answer (model returned no content).');
  }
  await expect(bubble).toBeAttached();
  const text = (await bubble.innerText()).trim();
  expect(text.length).toBeGreaterThan(60);
  return text;
}

test.describe('Free anonymous chats (site OpenRouter key)', () => {
  test('anonymous free chat streams an answer and shows the credit chip', async ({ page, request }) => {
    const quota = await workerFreeQuota(request);
    test.skip(
      !quota || quota.remaining <= 0 || quota.is_free_tier,
      'No funded OPEN_ROUTER_KEY in worker/.dev.vars (free chat needs the site key + credit)',
    );

    // No key seeded → the key dot stays grey and the free credit chip renders.
    await page.goto('/');
    await expect(page.locator('.ai-key-dot.ok')).not.toBeVisible();
    await expect(page.locator('.ai-free-chip')).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('.ai-free-chip').innerText()).toMatch(/Free credit: \$\d/);

    // The welcome panel is a quiet hint, not a forced connect.
    await expect(page.locator('.ai-welcome-connect')).toContainText('Chats are free');

    await ask(page, 'Which sector has the most open interest across all expirations? Give a one-line answer.');
    const text = await lastAnswer(page, 300_000);
    expect(text.length).toBeGreaterThan(60);
    await page.screenshot({ path: 'test-results/free-chat-answer.png', fullPage: true });
  });

  test('free credit exhausted mid-chat pivots to the Connect OpenRouter gate', async ({ page }) => {
    // Route-stub: quota open, but completions return 402 — exercises the
    // 402 → FreeCreditExhausted → connect-gate path with no credit spent and
    // no key needed.
    await page.route('**/api/free/quota', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ remaining: 5, limit: 100, is_free_tier: false, model: '~deepseek/deepseek-v4-flash-latest' }),
      }),
    );
    await page.route('**/api/free/v1/chat/completions', (route) =>
      route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'free_credit_exhausted', remaining: 0 } }),
      }),
    );
    await page.goto('/');
    await ask(page, 'Hello');
    // The composer submit becomes the "Free credit's out" connect gate.
    await expect(page.getByRole('button', { name: /Free credit's out/i })).toBeVisible({ timeout: 30_000 });
  });

  test('free quota at 0 on mount shows the exhausted connect gate', async ({ page }) => {
    // Route-stub quota → { remaining: 0 } so the gate appears on load — no
    // credit spent, no key needed.
    await page.route('**/api/free/quota', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ remaining: 0, limit: 100, is_free_tier: false, model: '~deepseek/deepseek-v4-flash-latest' }),
      }),
    );
    await page.goto('/');
    // Welcome empty-state shows the exhausted CTA, and the composer submit is
    // the connect gate rather than a send button.
    await expect(page.locator('.ai-welcome-connect')).toContainText("Free credit's out", { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Free credit's out/i })).toBeVisible();
  });
});