import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_OG_DESCRIPTION,
  DEFAULT_TITLE,
  SITE_NAME,
  pageMetaForUrl,
  pageMetaTags,
  truncateTitle,
} from './pageMeta.ts';

test('homepage keeps the brand title and split descriptions', () => {
  const meta = pageMetaForUrl('/');
  assert.equal(meta.title, DEFAULT_TITLE);
  assert.match(meta.description, /Ask the Lobster/);
  assert.equal(meta.ogDescription, DEFAULT_OG_DESCRIPTION);
  assert.equal(meta.path, '/');
});

test('research ticker is in the title, description, and canonical path', () => {
  const meta = pageMetaForUrl('/research/SPY');
  assert.equal(meta.title, `SPY – Research · ${SITE_NAME}`);
  assert.match(meta.description, /SPY/);
  assert.equal(meta.path, '/research/SPY');
});

test('research ticker is case-normalized', () => {
  const meta = pageMetaForUrl('/research/spy');
  assert.equal(meta.title, `SPY – Research · ${SITE_NAME}`);
  assert.equal(meta.path, '/research/SPY');
});

test('legacy /symbol/:ticker uses the same research title', () => {
  const meta = pageMetaForUrl('/symbol/NVDA');
  assert.equal(meta.title, `NVDA – Research · ${SITE_NAME}`);
});

test('research landing has no ticker', () => {
  const meta = pageMetaForUrl('/research');
  assert.equal(meta.title, `Research · ${SITE_NAME}`);
  assert.doesNotMatch(meta.title, /SPY/);
});

test('profile handle is in the profile title', () => {
  const meta = pageMetaForUrl('/u/thelobster');
  assert.equal(meta.title, `@thelobster – Profile · ${SITE_NAME}`);
  assert.match(meta.description, /@thelobster/);
  assert.match(meta.description, /Profile and public chats/);
});

test('data catalog item uses the lake table name', () => {
  const meta = pageMetaForUrl('/data', '?item=table:ohlc');
  assert.equal(meta.title, `options.ohlc – Data · ${SITE_NAME}`);
  assert.equal(meta.path, '/data?item=table%3Aohlc');
});

test('data query item and sql search both select Query the lake', () => {
  assert.equal(pageMetaForUrl('/data', '?item=query').title, `Query the lake – Data · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/data', '?sql=SELECT%201').title, `Query the lake – Data · ${SITE_NAME}`);
});

test('docs pages name the topic', () => {
  const meta = pageMetaForUrl('/docs/pipeline');
  assert.equal(meta.title, `Data pipeline – Docs · ${SITE_NAME}`);
  const pnl = pageMetaForUrl('/docs/schwab-pnl');
  assert.equal(pnl.title, `Schwab Performance – Docs · ${SITE_NAME}`);
  assert.match(pnl.description ?? '', /Performance chart/);
});

test('chat, monitor, admin, brand, bots, users, chats, account, and share have route titles', () => {
  assert.equal(pageMetaForUrl('/chat').title, `Chat · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/monitor').title, `Dataset monitor · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/admin').title, `Admin · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/admin').description ?? '', /Admin hub/);
  assert.equal(pageMetaForUrl('/brand').title, `Brand · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/bots').title, `Bots · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/users').title, `Users · ${SITE_NAME}`);
  assert.equal(pageMetaForUrl('/chats').title, `Chats · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/chats').description ?? '', /visitor fingerprints/);
  assert.equal(pageMetaForUrl('/portfolio').title, `Portfolio · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/portfolio').description ?? '', /lobster suggested-trade/);
  assert.equal(pageMetaForUrl('/account').title, `Account · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/account').description ?? '', /public handle/);
  assert.equal(pageMetaForUrl('/my-bots').title, `My bots · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/my-bots').description ?? '', /US market hours/);
  assert.equal(pageMetaForUrl('/copilot').title, `Copilot internals · ${SITE_NAME}`);
  assert.match(pageMetaForUrl('/copilot').description ?? '', /system prompts/);
  assert.equal(pageMetaForUrl('/share/abc').title, `Shared chat · ${SITE_NAME}`);
});

test('pageMetaTags emit title, description, canonical, og, and twitter', () => {
  const tags = pageMetaTags(pageMetaForUrl('/research/SPY'), 'https://lobster.mp');
  const by = (kind: string, key?: string) =>
    tags.find((tag) =>
      kind === 'title' ? tag.kind === 'title'
        : kind === 'link' ? tag.kind === 'link' && tag.rel === key
        : tag.kind === 'meta' && tag.key === key,
    );

  assert.equal(by('title')?.kind === 'title' ? by('title').text : '', `SPY – Research · ${SITE_NAME}`);
  assert.equal(by('meta', 'description')?.kind === 'meta' ? by('meta', 'description').content : '', 'Spot, options chain, implied vol, greeks, and news for SPY.');
  assert.equal(by('link', 'canonical')?.kind === 'link' ? by('link', 'canonical').href : '', 'https://lobster.mp/research/SPY');
  assert.equal(by('meta', 'og:title')?.kind === 'meta' ? by('meta', 'og:title').content : '', `SPY – Research · ${SITE_NAME}`);
  assert.equal(by('meta', 'og:url')?.kind === 'meta' ? by('meta', 'og:url').content : '', 'https://lobster.mp/research/SPY');
  assert.equal(by('meta', 'twitter:title')?.kind === 'meta' ? by('meta', 'twitter:title').content : '', `SPY – Research · ${SITE_NAME}`);
  assert.equal(by('meta', 'og:image')?.kind === 'meta' ? by('meta', 'og:image').content : '', 'https://lobster.mp/og.png');
});

test('truncateTitle prefers the opening sentence over a mid-word cut', () => {
  const prompt =
    "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow.";
  assert.equal(truncateTitle(prompt, 60), "Hourly market overview: what's happening right now?");
  const noSentence = 'Lead with SPX QQQ IWM posture sector leadership or rotation and the unusual options flow today';
  const clipped = truncateTitle(noSentence, 60);
  assert.ok(clipped.endsWith('…'));
  assert.ok(clipped.length <= 60);
  assert.match(clipped, /\s\S+…$/);
});

test('experiments routes have titles', () => {
  assert.equal(pageMetaForUrl('/experiments').title, `Experiments · ${SITE_NAME}`);
  const experiment = pageMetaForUrl('/experiments/text-vs-image');
  assert.equal(experiment.title, `Text vs image experiment · ${SITE_NAME}`);
  assert.match(experiment.description ?? '', /AI-style text/);
  assert.doesNotMatch(experiment.description ?? '', /Copilot-style/);
});
