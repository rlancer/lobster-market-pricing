import assert from 'node:assert/strict';
import test from 'node:test';
import worker, {
  isCrawlerPlainPath,
  shouldSpaFallback,
  wantsHtml,
} from './metaWorker.ts';

test('crawler plain paths are robots.txt and sitemap.xml only', () => {
  assert.equal(isCrawlerPlainPath('/robots.txt'), true);
  assert.equal(isCrawlerPlainPath('/sitemap.xml'), true);
  assert.equal(isCrawlerPlainPath('/chat'), false);
  assert.equal(isCrawlerPlainPath('/robots.txt.bak'), false);
});

test('SPA fallback skips asset extensions and crawler files', () => {
  assert.equal(shouldSpaFallback('/chat', 404, true), true);
  assert.equal(shouldSpaFallback('/research/SPY', 404, true), true);
  assert.equal(shouldSpaFallback('/robots.txt', 404, true), false);
  assert.equal(shouldSpaFallback('/sitemap.xml', 404, true), false);
  assert.equal(shouldSpaFallback('/assets/app.js', 404, true), false);
  assert.equal(shouldSpaFallback('/og.png', 404, true), false);
  assert.equal(shouldSpaFallback('/chat', 200, true), false);
  assert.equal(shouldSpaFallback('/chat', 404, false), false);
});

test('wantsHtml treats empty Accept and */* as HTML-capable', () => {
  assert.equal(wantsHtml(new Request('https://lobster.mp/chat')), true);
  assert.equal(wantsHtml(new Request('https://lobster.mp/chat', { headers: { Accept: '*/*' } })), true);
  assert.equal(wantsHtml(new Request('https://lobster.mp/chat', { headers: { Accept: 'text/html' } })), true);
  assert.equal(wantsHtml(new Request('https://lobster.mp/chat', { headers: { Accept: 'text/plain' } })), false);
  assert.equal(wantsHtml(new Request('https://lobster.mp/chat', { method: 'POST' })), false);
});

function mockEnv(routes: Record<string, Response>) {
  return {
    ASSETS: {
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        const hit = routes[path];
        if (hit) return hit.clone();
        return new Response('missing', { status: 404 });
      },
    },
  };
}

test('robots.txt passes through a real text/plain asset', async () => {
  const body = 'User-agent: *\nAllow: /\n';
  const env = mockEnv({
    '/robots.txt': new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
  });
  const res = await worker.fetch(new Request('https://lobster.mp/robots.txt'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.equal(text, body);
  assert.doesNotMatch(text, /<!doctype/i);
  assert.doesNotMatch(text, /<html/i);
});

test('robots.txt rejects HTML SPA shell with a plain 404', async () => {
  const env = mockEnv({
    '/robots.txt': new Response('<!doctype html><html><body>app</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  const res = await worker.fetch(new Request('https://lobster.mp/robots.txt'), env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  const text = await res.text();
  assert.doesNotMatch(text, /<!doctype/i);
  assert.doesNotMatch(text, /<html/i);
  assert.doesNotMatch(text, /<script/i);
});

test('sitemap.xml rejects HTML SPA shell with a plain 404', async () => {
  const env = mockEnv({
    '/sitemap.xml': new Response('<!doctype html><title>Lobster</title>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  const res = await worker.fetch(new Request('https://lobster.mp/sitemap.xml'), env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.doesNotMatch(await res.text(), /<!doctype/i);
});

test('missing robots.txt is a plain 404, not index.html', async () => {
  const env = mockEnv({
    '/index.html': new Response('<!doctype html><html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  const res = await worker.fetch(new Request('https://lobster.mp/robots.txt'), env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.doesNotMatch(await res.text(), /<!doctype/i);
});

test('extensionless app routes still SPA-fallback to index.html', async () => {
  let sawIndex = false;
  const env = {
    ASSETS: {
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === '/index.html') {
          sawIndex = true;
          return new Response('<!doctype html><html><head><title>x</title></head><body></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('missing', { status: 404 });
      },
    },
  };

  // HTMLRewriter is Cloudflare-only; stub a pass-through for this Node unit test.
  const prev = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  class PassthroughRewriter {
    on() {
      return this;
    }
    transform(response: Response) {
      return response;
    }
  }
  (globalThis as { HTMLRewriter: unknown }).HTMLRewriter = PassthroughRewriter;

  try {
    const res = await worker.fetch(
      new Request('https://lobster.mp/chat', { headers: { Accept: 'text/html' } }),
      env,
    );
    assert.equal(sawIndex, true);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  } finally {
    if (prev === undefined) delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
    else (globalThis as { HTMLRewriter: unknown }).HTMLRewriter = prev;
  }
});
