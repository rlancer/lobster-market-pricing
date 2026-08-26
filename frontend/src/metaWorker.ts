import { pageMetaForUrl, pageMetaTags, type PageMeta } from './pageMeta.ts';

interface PagesEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

/** Path has a file extension (asset-like) — never SPA-fallback these. */
const ASSET_EXT = /\.[a-zA-Z0-9]{1,8}$/;

/**
 * Well-known crawler files. Must never be replaced with the SPA shell — Cloudflare
 * managed robots.txt prepends to whatever the origin returns for `/robots.txt`, so
 * an HTML body gets glued on as text/plain.
 */
const CRAWLER_PLAIN_PATHS = new Set(['/robots.txt', '/sitemap.xml']);

export function isCrawlerPlainPath(pathname: string): boolean {
  return CRAWLER_PLAIN_PATHS.has(pathname);
}

export function wantsHtml(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.get('Accept') ?? '';
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
}

/** Whether a missing ASSETS response should fall back to `index.html`. */
export function shouldSpaFallback(pathname: string, status: number, acceptHtml: boolean): boolean {
  if (status !== 404 || !acceptHtml) return false;
  if (isCrawlerPlainPath(pathname)) return false;
  if (ASSET_EXT.test(pathname)) return false;
  return true;
}

function plainNotFound(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function rewritePageMeta(response: Response, meta: PageMeta, origin: string): Response {
  let rewriter = new HTMLRewriter();
  for (const tag of pageMetaTags(meta, origin)) {
    if (tag.kind === 'title') {
      rewriter = rewriter.on('title', {
        element(el) {
          el.setInnerContent(tag.text);
        },
      });
      continue;
    }
    if (tag.kind === 'link') {
      rewriter = rewriter.on(`link[rel="${tag.rel}"]`, {
        element(el) {
          el.setAttribute('href', tag.href);
        },
      });
      continue;
    }
    rewriter = rewriter.on(`meta[${tag.attr}="${tag.key}"]`, {
      element(el) {
        el.setAttribute('content', tag.content);
      },
    });
  }
  return rewriter.transform(response);
}

export default {
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    const url = new URL(request.url);
    let response = await env.ASSETS.fetch(request);

    // Crawler files: serve the static asset as-is. If a stale SPA redirect (or
    // missing file) produced HTML, return a clean plain 404 instead of the app shell.
    if (isCrawlerPlainPath(url.pathname)) {
      const contentType = response.headers.get('content-type') ?? '';
      if (response.status === 404 || contentType.includes('text/html')) {
        return plainNotFound();
      }
      return response;
    }

    if (shouldSpaFallback(url.pathname, response.status, wantsHtml(request))) {
      const indexRequest = new Request(new URL('/index.html', url.origin), request);
      response = await env.ASSETS.fetch(indexRequest);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return response;

    const meta = pageMetaForUrl(url.pathname, url.search);
    return rewritePageMeta(response, meta, url.origin);
  },
};
