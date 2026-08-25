import { catalogItem } from './dataCatalog.ts';
import { handleInputError } from './handle.ts';

/** Brand strings — homepage defaults match `index.html`. */
export const SITE_NAME = 'Lobster MP';
export const DEFAULT_TITLE = 'Lobster MP – Ask the Lobster';
export const DEFAULT_DESCRIPTION =
  'Ask the Lobster — live US equities & ETF options chains, implied vol, greeks, news, and SQL. Free options Copilot on Cloudflare.';
export const DEFAULT_OG_DESCRIPTION =
  'A crustacean who\'s seen every cycle, chat stocks, options, greeks, and news.';
export const OG_IMAGE_PATH = '/og.png';
export const OG_IMAGE_ALT = 'Blue lobster mascot in sunglasses';

export interface PageMeta {
  title: string;
  description: string;
  /** Open Graph / Twitter description; falls back to `description`. */
  ogDescription?: string;
  /** Canonical path (pathname + selected search), always starting with `/`. */
  path: string;
}

export type PageMetaTag =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; attr: 'name' | 'property'; key: string; content: string }
  | { kind: 'link'; rel: string; href: string };

const DOCS: Record<string, { title: string; description: string }> = {
  overview: {
    title: 'Overview & architecture',
    description:
      'How Lobster MP works: CBOE delayed quotes, Cloudflare Pipelines, an Iceberg lake, and the screener API.',
  },
  pipeline: {
    title: 'Data pipeline',
    description:
      'CBOE delayed quotes flow through the loader Worker and Cloudflare Pipelines into the R2 Data Catalog Iceberg lake.',
  },
  backend: {
    title: 'Backend & API',
    description:
      'The screener API Worker turns Iceberg lake SQL into JSON for Chat, Research, the Data catalog, and the monitor.',
  },
  exploration: {
    title: 'Exploration',
    description:
      'Read-only DataFusion SQL against options.* — the same surface Chat uses via run_query.',
  },
  frontend: {
    title: 'Frontend surfaces',
    description:
      'Timeline, Chat, Research, the Data catalog, monitor, and brand — the React UI on top of the screener API.',
  },
  run: {
    title: 'Run it locally',
    description: 'Run the Vite frontend and screener API Worker locally with mise.',
  },
  deploy: {
    title: 'Deployment',
    description:
      'Cloudflare Pages for the UI, a Worker for the API, and the loader Worker for CBOE ingestion.',
  },
};

function pageTitle(head: string): string {
  return `${head} · ${SITE_NAME}`;
}

function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  const decoded = decodeURIComponent(pathname);
  if (decoded.length > 1 && decoded.endsWith('/')) return decoded.slice(0, -1);
  return decoded;
}

function tickerFromSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  const ticker = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) return null;
  return ticker;
}

function handleFromSegment(raw: string | undefined): string | null {
  if (!raw) return null;
  const handle = raw.trim().toLowerCase();
  if (handleInputError(handle)) return null;
  return handle;
}

function searchParams(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

function dataMeta(pathname: string, params: URLSearchParams): PageMeta {
  const itemId = params.get('item')?.trim() || (params.get('sql') ? 'query' : '');
  const item = itemId ? catalogItem(itemId) : undefined;
  if (!item || item.kind === 'overview') {
    return {
      title: pageTitle('Data catalog'),
      description:
        'Catalog of Copilot tools, live APIs, Iceberg lake tables, and a read-only SQL editor.',
      path: pathname,
    };
  }
  const head = item.kind === 'table' ? `options.${item.title}` : item.title;
  const canonical = `${pathname}?item=${encodeURIComponent(item.id)}`;
  return {
    title: pageTitle(`${head} – Data`),
    description: item.summary || item.description,
    path: canonical,
  };
}

function researchMeta(ticker: string | null): PageMeta {
  if (!ticker) {
    return {
      title: pageTitle('Research'),
      description:
        "Spot, chart, the Lobster's take, and the options chain for one underlying. Search any ticker.",
      path: '/research',
    };
  }
  return {
    title: pageTitle(`${ticker} – Research`),
    description: `Spot, options chain, implied vol, greeks, and news for ${ticker}.`,
    path: `/research/${encodeURIComponent(ticker)}`,
  };
}

/**
 * Route metadata from the URL alone — used by in-app navigation and by the
 * Cloudflare Pages worker that rewrites `index.html` for crawlers.
 */
export function pageMetaForUrl(pathname: string, search = ''): PageMeta {
  const path = normalizePath(pathname);
  const params = searchParams(search);
  const segments = path === '/' ? [] : path.slice(1).split('/');

  if (path === '/') {
    return {
      title: DEFAULT_TITLE,
      description: DEFAULT_DESCRIPTION,
      ogDescription: DEFAULT_OG_DESCRIPTION,
      path: '/',
    };
  }

  if (path === '/chat' || path === '/ai') {
    return {
      title: pageTitle('Chat'),
      description: DEFAULT_DESCRIPTION,
      ogDescription: DEFAULT_OG_DESCRIPTION,
      path: '/chat',
    };
  }

  if (segments[0] === 'chat' && segments.length === 2) {
    return {
      title: pageTitle('Chat'),
      description: DEFAULT_DESCRIPTION,
      ogDescription: DEFAULT_OG_DESCRIPTION,
      path,
    };
  }

  if (path === '/research') return researchMeta(null);
  if (segments[0] === 'research' && segments.length === 2) {
    return researchMeta(tickerFromSegment(segments[1]));
  }
  if (segments[0] === 'symbol' && segments.length === 2) {
    return researchMeta(tickerFromSegment(segments[1]));
  }

  if (path === '/data' || path === '/lab' || path === '/market') {
    return dataMeta('/data', path === '/market' ? new URLSearchParams() : params);
  }

  if (path === '/monitor') {
    return {
      title: pageTitle('Dataset monitor'),
      description:
        'Refresh-run history from the lake, plus the live loader loop — per-symbol state, backoffs, and the market-hours gate.',
      path: '/monitor',
    };
  }

  if (path === '/admin') {
    return {
      title: pageTitle('Admin'),
      description:
        'Admin hub for bots, users, chats, Copilot internals, and brand — operator tools behind one left-nav entry.',
      path: '/admin',
    };
  }

  if (path === '/brand') {
    return {
      title: pageTitle('Brand'),
      description:
        'Style guide and shareable assets: mascot, sunglasses mark, palette, type, and Open Graph files.',
      path: '/brand',
    };
  }

  if (path === '/bots') {
    return {
      title: pageTitle('Bots'),
      description:
        'Admin-only Copilot personas — edit handles like nowlobster / yololobster and generate public timeline chats.',
      path: '/bots',
    };
  }

  if (path === '/portfolio') {
    return {
      title: pageTitle('Portfolio'),
      description:
        'Public lobster suggested-trade performance and an optional signed-in paper book, filterable by conviction.',
      path: '/portfolio',
    };
  }

  if (path === '/account') {
    return {
      title: pageTitle('Account'),
      description:
        'Claim a public handle, set your display name and photo, choose how Lobster replies, and sign out.',
      path: '/account',
    };
  }

  if (path === '/users') {
    return {
      title: pageTitle('Users'),
      description:
        'Admin-only directory of everyone who signed in with Google — email, handle, signup time, and chat count.',
      path: '/users',
    };
  }

  if (path === '/chats') {
    return {
      title: pageTitle('Chats'),
      description:
        'Admin-only directory of Copilot conversations — signed-in profiles or anonymous visitor fingerprints from IP and browser.',
      path: '/chats',
    };
  }

  if (path === '/copilot') {
    return {
      title: pageTitle('Copilot internals'),
      description:
        'Admin-only explorer for live Copilot system prompts and tool input schemas from the Worker.',
      path: '/copilot',
    };
  }

  if (path === '/experiments' || path === '/notebooks') {
    return {
      title: pageTitle('Experiments'),
      description:
        'Public experiments — text vs image context studies and other model-encoding probes, with server-saved runs from API or CI.',
      path: path === '/notebooks' ? '/notebooks' : '/experiments',
    };
  }

  if (path === '/experiments/text-vs-image' || path === '/notebooks/text-vs-image') {
    return {
      title: pageTitle('Text vs image experiment'),
      description:
        'Compare Copilot-style text, labeled chart images, and textless charts with a markdown color key for multimodal LLM accuracy on synthetic equity panels.',
      path: path.startsWith('/notebooks') ? path : '/experiments/text-vs-image',
    };
  }

  if (path === '/docs' || path.startsWith('/docs/')) {
    const slug = path === '/docs' ? 'overview' : (segments[1] ?? 'overview');
    const doc = DOCS[slug] ?? DOCS.overview;
    return {
      title: pageTitle(`${doc.title} – Docs`),
      description: doc.description,
      path: slug === 'overview' && path === '/docs' ? '/docs/overview' : path,
    };
  }

  if (segments[0] === 'share' && segments.length === 2) {
    return {
      title: pageTitle('Shared chat'),
      description: 'A shared Copilot transcript on Lobster MP.',
      path,
    };
  }

  if (segments[0] === 'u' && segments.length === 2) {
    const handle = handleFromSegment(segments[1]);
    if (handle) {
      return {
        title: pageTitle(`@${handle} – Profile`),
        description: `Profile and public chats shared by @${handle} on Lobster MP.`,
        path: `/u/${encodeURIComponent(handle)}`,
      };
    }
  }

  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    ogDescription: DEFAULT_OG_DESCRIPTION,
    path,
  };
}

export function pageMetaTags(meta: PageMeta, origin: string): PageMetaTag[] {
  const originBase = origin.replace(/\/$/, '');
  const url = `${originBase}${meta.path}`;
  const ogDescription = meta.ogDescription ?? meta.description;
  const image = `${originBase}${OG_IMAGE_PATH}`;
  return [
    { kind: 'title', text: meta.title },
    { kind: 'meta', attr: 'name', key: 'description', content: meta.description },
    { kind: 'link', rel: 'canonical', href: url },
    { kind: 'meta', attr: 'property', key: 'og:type', content: 'website' },
    { kind: 'meta', attr: 'property', key: 'og:site_name', content: SITE_NAME },
    { kind: 'meta', attr: 'property', key: 'og:locale', content: 'en_US' },
    { kind: 'meta', attr: 'property', key: 'og:url', content: url },
    { kind: 'meta', attr: 'property', key: 'og:title', content: meta.title },
    { kind: 'meta', attr: 'property', key: 'og:description', content: ogDescription },
    { kind: 'meta', attr: 'property', key: 'og:image', content: image },
    { kind: 'meta', attr: 'property', key: 'og:image:alt', content: OG_IMAGE_ALT },
    { kind: 'meta', attr: 'name', key: 'twitter:card', content: 'summary_large_image' },
    { kind: 'meta', attr: 'name', key: 'twitter:title', content: meta.title },
    { kind: 'meta', attr: 'name', key: 'twitter:description', content: ogDescription },
    { kind: 'meta', attr: 'name', key: 'twitter:image', content: image },
    { kind: 'meta', attr: 'name', key: 'twitter:image:alt', content: OG_IMAGE_ALT },
  ];
}

/** Mutate the document head in place so we replace `index.html` tags instead of duplicating them. */
export function applyPageMeta(meta: PageMeta, origin: string): void {
  for (const tag of pageMetaTags(meta, origin)) {
    if (tag.kind === 'title') {
      document.title = tag.text;
      continue;
    }
    if (tag.kind === 'link') {
      let el = document.head.querySelector(`link[rel="${cssEscape(tag.rel)}"]`);
      if (!el) {
        el = document.createElement('link');
        el.setAttribute('rel', tag.rel);
        document.head.appendChild(el);
      }
      el.setAttribute('href', tag.href);
      continue;
    }
    const selector = `meta[${tag.attr}="${cssEscape(tag.key)}"]`;
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(tag.attr, tag.key);
      document.head.appendChild(el);
    }
    el.setAttribute('content', tag.content);
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/"/g, '\\"');
}

export function truncateTitle(text: string, max = 60): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (trimmed.length <= max) return trimmed;

  // Prefer the opening sentence when it fits (same rule as worker clipTitle).
  const sentence = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentence && sentence[1].length >= 12 && sentence[1].length <= max) {
    return sentence[1];
  }

  const budget = max - 1;
  let slice = trimmed.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= Math.min(24, Math.floor(budget * 0.4))) {
    slice = slice.slice(0, lastSpace);
  }
  return `${slice.trimEnd()}…`;
}
