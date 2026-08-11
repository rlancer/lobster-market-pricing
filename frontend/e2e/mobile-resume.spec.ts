import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Reproduction for the mobile "network error" chat bug.
//
// The failure: on a real phone, backgrounding the tab makes the OS tear down
// the in-flight /api/chat SSE socket. The pre-fix Worker kept running but
// DISCARDED the finished answer (nothing recoverable), and the pre-fix client
// had no path back to it — so the reopened tab showed a permanent network
// error even though the run completed. The fix persists the completed result
// per chat_id and exposes it via GET /api/chat/result, so the client can
// resume it.
//
// Playwright cannot make Cloudflare observe a half-open StreamableHTTP socket
// as a server-side disconnect (offline/CSP emulation just pauses it). The
// deterministic analog that CAN be observed server-side is actually closing
// the client connection mid-stream — like the OS taking the whole app down —
// and then asking the worker whether the finished answer survived.
//
// Select the terminal state the environment is EXPECTED to exhibit so each run
// is a green, meaningful assertion:
//   EXPECT=recovery (staging, fix) → the finished answer is persisted and the
//        resume endpoint serves it for the interrupted chat_id (NOT lost).
//   EXPECT=bug      (prod, pre-fix) → the endpoint does not exist; the answer
//        is unrecoverable — the data-loss half of the reported bug.
//
// Run via playwright.remote.config.ts:
//   E2E_TARGET=staging EXPECT=recovery npx playwright test --config playwright.remote.config.ts
//   E2E_TARGET=prod    EXPECT=bug      npx playwright test --config playwright.remote.config.ts
// ---------------------------------------------------------------------------

const API = process.env.E2E_API_URL ?? '';
const EXPECT = (process.env.EXPECT ?? 'recovery') as 'recovery' | 'bug';
if (!API) throw new Error('E2E_API_URL not set — run via playwright.remote.config.ts');

const QUESTION = 'Give a concise two-sentence overview of put options.';

async function openChat(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({ timeout: 60_000 });
}

async function ask(page: Page, question: string): Promise<void> {
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await composer.fill(question);
  await page.keyboard.press('Enter');
}

/** True once real SSE progress is flowing (thinking tokens, a tool row, or a
 * status beyond the initial "Starting…") — i.e. the run is genuinely underway. */
async function waitForStreaming(page: Page): Promise<void> {
  await expect(page.locator('.ai-busy')).toBeVisible({ timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const busy = document.querySelector('.ai-busy');
      if (!busy) return false;
      const status = busy.querySelector('.ai-busy-status')?.textContent ?? '';
      return (
        !!busy.querySelector('.ai-tool-row') ||
        !!busy.querySelector('.ai-thinking') ||
        (status.trim() !== '' && status.trim() !== 'Starting…')
      );
    },
    undefined,
    { timeout: 120_000 },
  );
}

test('answer survives an interrupted stream via the resume endpoint', async ({ page, context, request }) => {
  test.setTimeout(480_000);
  await openChat(page);

  // Capture the client's chat_id before we kill the connection.
  const chatReq = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().startsWith(`${API}/api/chat`),
    { timeout: 90_000 },
  );
  await ask(page, QUESTION);
  const chatId = (await chatReq).postDataJSON().chat_id as string;
  expect(chatId).toBeTruthy();

  await waitForStreaming(page);

  // "Close the phone": abruptly drop the whole client connection mid-answer.
  // The Worker is then mid-run; it detects the write failure, keeps running,
  // and (on the fix) persists the completed result for this chat_id.
  await context.close();

  if (EXPECT === 'recovery') {
    // Fixed behavior: the finished answer is NOT lost. The resume endpoint
    // eventually serves it ready:true for the interrupted chat_id.
    await expect
      .poll(
        async () => {
          const r = await request.get(`${API}/api/chat/result?chat_id=${chatId}`);
          if (r.status() === 404) return false;
          if (!r.ok()) return false;
          const j = (await r.json()) as { ready?: boolean; answer?: string };
          return j?.ready === true && typeof j?.answer === 'string' && j.answer.length > 0;
        },
        { timeout: 240_000, intervals: [2_000, 5_000, 15_000] },
      )
      .toBe(true);

    const r = await request.get(`${API}/api/chat/result?chat_id=${chatId}`);
    const j = (await r.json()) as { answer?: string; model?: string };
    console.log(`[staging] recovered answer (${j.answer?.length ?? 0} chars, model=${j.model}) for chat ${chatId}`);
  } else {
    // Pre-fix (prod): there is no resume endpoint, so the interrupted answer is
    // unrecoverable — the client has nothing to come back to. The 404 is the
    // missing-recovery reproduction.
    const r = await request.get(`${API}/api/chat/result?chat_id=${chatId}`);
    expect(r.status()).toBe(404);
    const j = (await r.json()) as { error?: string };
    expect(String(j?.error ?? '')).toBeTruthy();
    console.log(`[prod] reproduced: no resume endpoint (${JSON.stringify(j)}) — answer unrecoverable`);
  }
});
