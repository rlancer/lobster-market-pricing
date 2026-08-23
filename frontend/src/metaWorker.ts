import { pageMetaForUrl, pageMetaTags, type PageMeta } from './pageMeta.ts';

interface PagesEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const ASSET_EXT = /\.[a-zA-Z0-9]{1,8}$/;

function wantsHtml(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.get('Accept') ?? '';
  return accept.includes('text/html') || accept.includes('*/*') || accept === '';
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

    if (
      response.status === 404
      && wantsHtml(request)
      && !ASSET_EXT.test(url.pathname)
    ) {
      const indexRequest = new Request(new URL('/index.html', url.origin), request);
      response = await env.ASSETS.fetch(indexRequest);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return response;

    // Marimo islands / html-wasm pages own their <title> and head; rewriting
    // them for SPA OG tags can confuse the WASM bootstrap UI.
    if (url.pathname.startsWith('/notebooks/')) return response;

    const meta = pageMetaForUrl(url.pathname, url.search);
    return rewritePageMeta(response, meta, url.origin);
  },
};
