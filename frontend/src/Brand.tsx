import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, HStack, Tab, TabList, Theme, Token } from '@astryxdesign/core';
import { useIsAdmin } from './useAdmin';
import { lobsterTheme } from './theme';
import { BlueLobsterLogo } from './BlueLobsterLogo';
import { ProfileSunglasses, Sunglasses } from './Sunglasses';
import './Brand.css';

// ---------------------------------------------------------------------------
// Brand style guide — logos, palette, type, voice, and shareable assets.
// Source of truth for the visual system lives in theme.ts + the SVG marks;
// this page is the living reference. Admin-only — linked from the Admin hub
// (/admin) and redirected for non-admin sessions.
// ---------------------------------------------------------------------------

const BRAND_PAGES = [
  { id: 'identity', num: '01', label: 'Identity' },
  { id: 'logos', num: '02', label: 'Logos & marks' },
  { id: 'avatar', num: '03', label: 'Avatar' },
  { id: 'color', num: '04', label: 'Color' },
  { id: 'typography', num: '05', label: 'Typography' },
  { id: 'shape', num: '06', label: 'Shape & motion' },
  { id: 'components', num: '07', label: 'Components' },
  { id: 'voice', num: '08', label: 'Brand voice' },
  { id: 'assets', num: '09', label: 'Assets' },
] as const;

const META = [
  ['Product', 'Lobster MP'],
  ['Domain', 'lobster.mp'],
  ['Tagline', 'Ask the Lobster'],
  ['Theme', 'lobster-market · dark'],
];

const COLORS: { name: string; token: string; chip: string; hex: string }[] = [
  { name: 'Body', token: '--color-background-body', chip: 'bg-body', hex: '#07131F' },
  { name: 'Surface', token: '--color-background-surface', chip: 'bg-surface', hex: '#0C1C29' },
  { name: 'Card', token: '--color-background-card', chip: 'bg-card', hex: '#102432' },
  { name: 'Muted', token: '--color-background-muted', chip: 'bg-muted', hex: '#102230' },
  { name: 'Text', token: '--color-text-primary', chip: 'text-primary', hex: '#EAF7F3' },
  { name: 'Secondary', token: '--color-text-secondary', chip: 'text-secondary', hex: '#8EA8AA' },
  { name: 'Accent', token: '--color-accent', chip: 'accent', hex: '#35D0BA' },
  { name: 'Accent muted', token: '--color-accent-muted', chip: 'accent-muted', hex: '#35D0BA1F' },
  { name: 'Text accent', token: '--color-text-accent', chip: 'text-accent', hex: '#62E4D1' },
  { name: 'Icon blue', token: '--color-icon-blue', chip: 'icon-blue', hex: '#9EB7FF' },
  { name: 'Border blue', token: '--color-border-blue', chip: 'border-blue', hex: '#6D9CFE' },
  { name: 'Success', token: '--color-success', chip: 'success', hex: '#49D89D' },
  { name: 'Error', token: '--color-error', chip: 'error', hex: '#FF806F' },
  { name: 'Warning', token: '--color-warning', chip: 'warning', hex: '#F4C05D' },
  { name: 'Call', token: '--call → success', chip: 'call', hex: '#49D89D' },
  { name: 'Put', token: '--put → error', chip: 'put', hex: '#FF806F' },
];

const ASSETS = [
  {
    title: 'Favicon',
    path: '/favicon.svg',
    body: 'Sunglasses mark only. Browser tab + bookmarks.',
    preview: '/favicon.svg',
  },
  {
    title: 'Apple touch icon',
    path: '/apple-touch-icon.png',
    body: 'Home-screen icon for iOS. Full mascot on dark field.',
    preview: '/apple-touch-icon.png',
  },
  {
    title: 'Open Graph',
    path: '/og.png',
    body: '1200×630 social share — mascot-only, no wordmark.',
    preview: '/og.png',
  },
  {
    title: 'OG square',
    path: '/og-square.png',
    body: '1:1 crop for platforms that prefer square previews.',
    preview: '/og-square.png',
  },
  {
    title: 'OG source',
    path: '/og.svg',
    body: 'Vector source for the OG render. Regenerate PNGs via npm run og:render.',
    preview: '/og.svg',
  },
];

function Section({
  id,
  num,
  title,
  children,
}: {
  id: string;
  num: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="brand-section">
      <h2>
        <span className="brand-sec-num">{num}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function BrandPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [active, setActive] = useState<string>(BRAND_PAGES[0].id);
  const [chromeTab, setChromeTab] = useState('chat');

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  useEffect(() => {
    if (!isAdmin) return;
    const nodes = BRAND_PAGES
      .map((page) => document.getElementById(page.id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target.id;
        if (top) setActive(top);
      },
      {
        root: null,
        rootMargin: '0px 0px -65% 0px',
        threshold: [0.1, 0.25, 0.5],
      },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [isAdmin]);

  if (isPending || !isAdmin) return null;

  return (
    <div className="brand">
      <nav className="brand-toc" aria-label="Brand sections">
        <span className="brand-toc-title">Brand</span>
        {BRAND_PAGES.map((page) => (
          <a
            key={page.id}
            href={`#${page.id}`}
            className={active === page.id ? 'brand-toc-link active' : 'brand-toc-link'}
            aria-current={active === page.id ? 'location' : undefined}
          >
            <span className="brand-toc-num">{page.num}</span>
            <span>{page.label}</span>
          </a>
        ))}
      </nav>

      <div className="brand-body">
        <header className="brand-hero">
          <BlueLobsterLogo className="brand-hero-mark" width={96} height={96} />
          <h1>Lobster MP</h1>
          <p className="brand-hero-tag">Ask the Lobster</p>
          <p>
            Style guide and asset shelf for the blue lobster in sunglasses — the marks, palette,
            type, motion, and voice used across Chat, Floor, share cards, and social previews.
          </p>
          <ul className="brand-meta">
            {META.map(([label, value]) => (
              <li key={label}>
                <b>{value}</b>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </header>

        <Section id="identity" num="01" title="Identity">
          <p className="brand-lede">
            Lobster MP is a free US equities &amp; ETF options chat on Cloudflare. The brand is
            the mascot first: a rare blue lobster wearing smug sunglasses. Product copy leads with
            the lobster, not a generic “AI platform” frame.
          </p>
          <h3>Naming</h3>
          <p className="brand-lede">
            <b>Lobster MP</b> is the product. <b>Ask the Lobster</b> is the invitation on Chat.
            In lockups, <b>Lobster</b> is the solid word and a secondary italic (e.g. <em>share</em>)
            can ride beside it. Handles live at <code>lobster.mp/u/&lt;handle&gt;</code> — that
            profile page lists the person&apos;s opted-in public chats.
          </p>
        </Section>

        <Section id="logos" num="02" title="Logos & marks">
          <p className="brand-lede">
            Three related marks, all drawn from the same path set. Prefer the component exports —
            they follow theme tokens so light/dark stay consistent.
          </p>
          <div className="brand-logo-grid">
            <article className="brand-logo-card">
              <div className="brand-logo-stage brand-logo-stage-dark">
                <BlueLobsterLogo width={88} height={88} />
              </div>
              <h3>Mascot</h3>
              <code>BlueLobsterLogo</code>
              <p>Full lobster. Chat welcome, OG art, apple-touch. Never crop the claws.</p>
            </article>
            <article className="brand-logo-card">
              <div className="brand-logo-stage brand-logo-stage-dark">
                <Sunglasses width={112} height={48} />
              </div>
              <h3>Mark</h3>
              <code>Sunglasses</code>
              <p>Chat assistant avatar and favicon. The glasses alone carry the brand at small sizes.</p>
            </article>
            <article className="brand-logo-card">
              <Theme theme={lobsterTheme} mode="light">
                <section className="brand-logo-stage" aria-label="Mascot on light background">
                  <BlueLobsterLogo width={88} height={88} />
                </section>
              </Theme>
              <h3>On light</h3>
              <code>Theme mode=&quot;light&quot;</code>
              <p>Same paths; fills/strokes flip with theme tokens. Keep clear space ≥ half the eye width.</p>
            </article>
          </div>
          <h3>Size ladder</h3>
          <div className="brand-size-row" aria-label="Mascot size samples">
            {[24, 32, 48, 64, 96].map((size) => (
              <div key={size} className="brand-size-item">
                <BlueLobsterLogo width={size} height={size} />
                <span>{size}px</span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="avatar" num="03" title="Avatar">
          <p className="brand-lede">
            Signed-in users get brand shades on a soft disc — not a Google profile photo.
            That keeps the product looking like Lobster even after login.
          </p>
          <div className="brand-size-row" aria-label="Avatar sizes">
            {[
              { size: 24, className: 'brand-avatar-sm' },
              { size: 32, className: 'brand-avatar-md' },
              { size: 40, className: 'brand-avatar-lg' },
              { size: 56, className: 'brand-avatar-xl' },
            ].map(({ size, className }) => (
              <div key={size} className="brand-size-item">
                <ProfileSunglasses className={className} />
                <span>{size}px</span>
              </div>
            ))}
          </div>
          <p className="brand-lede">
            Component: <code>ProfileSunglasses</code> in <code>Sunglasses.tsx</code> (via{' '}
            <code>UserAvatar</code>). Default header / profile face when no custom photo is
            uploaded — never the Google OAuth picture.
          </p>
        </Section>

        <Section id="color" num="04" title="Color">
          <p className="brand-lede">
            Dark is the shipped default (<code>Theme mode=&quot;dark&quot;</code>). Accent teal does
            the interactive work; periwinkle blue is reserved for the lobster stroke so the mascot
            never competes with CTAs. Defined in <code>theme.ts</code>.
          </p>
          <div className="brand-swatch-grid">
            {COLORS.map((color) => (
              <article key={color.token} className="brand-swatch">
                <div className={`brand-swatch-chip ${color.chip}`} aria-hidden="true" />
                <div className="brand-swatch-meta">
                  <b>{color.name}</b>
                  <code>{color.token}</code>
                  <code>{color.hex}</code>
                </div>
              </article>
            ))}
          </div>
        </Section>

        <Section id="typography" num="05" title="Typography">
          <p className="brand-lede">
            Headings are condensed and utilitarian; body is a clean UI sans; code is a coding face.
            Fallbacks keep Windows/macOS readable when the preferred fonts are missing.
          </p>
          <div className="brand-type-stack">
            <div className="brand-type-row">
              <span className="brand-type-label">Heading · Bahnschrift SemiCondensed</span>
              <p className="brand-type-heading">Ask the Lobster about SPX vol.</p>
            </div>
            <div className="brand-type-row">
              <span className="brand-type-label">Body · Aptos / Segoe UI</span>
              <p className="brand-type-body">
                Live options chains for US equities and the major ETFs — calls &amp; puts, strikes,
                implied vol, open interest, volume, greeks — plus spot quotes, IV rank, and news.
              </p>
            </div>
            <div className="brand-type-row">
              <span className="brand-type-label">Code · Cascadia Code</span>
              <p className="brand-type-code">
                SELECT ticker, implied_vol FROM option_contracts LIMIT 50
              </p>
            </div>
            <div className="brand-type-row">
              <span className="brand-type-label">Scale · base 14 / ratio 1.2</span>
              <div className="brand-type-scale">
                <span className="t-xs">xs — metadata, TOC nums, chip labels</span>
                <span className="t-sm">sm — supporting copy, table cells</span>
                <span className="t-base">base — body and controls</span>
                <span className="t-lg">lg — section emphasis</span>
                <span className="t-xl">xl — page titles</span>
              </div>
            </div>
          </div>
        </Section>

        <Section id="shape" num="06" title="Shape & motion">
          <p className="brand-lede">
            Radius stays tight (base 3, multiplier 0.72) — tool UI, not soft consumer chrome. Motion
            is short and purposeful: rise-ins for guides, a slow float on the hero mascot, pulse only
            for status.
          </p>
          <div className="brand-shape-row" aria-label="Radius samples">
            <div className="brand-shape-box r-element">element</div>
            <div className="brand-shape-box r-inner">inner</div>
            <div className="brand-shape-box r-container">container</div>
            <div className="brand-shape-box r-full">full</div>
          </div>
          <h3>Motion</h3>
          <div className="brand-motion-demo" aria-label="Motion samples">
            <div className="brand-motion-pill fast" title="fast · 140ms" />
            <div className="brand-motion-pill medium" title="medium · 320ms" />
          </div>
          <p className="brand-lede">
            Tokens: <code>--duration-fast</code> (140ms), <code>--duration-medium</code> (320ms),
            ratio 0.72. Honor <code>prefers-reduced-motion</code>.
          </p>
        </Section>

        <Section id="components" num="07" title="Components">
          <p className="brand-lede">
            Interactive chrome comes from Astryx on the lobster theme. TabList
            switches related views; Buttons are for actions. One primary action
            per view; tokens for metadata, never decoration.
          </p>
          <div className="brand-comp-row">
            <TabList
              size="sm"
              aria-label="Example views"
              value={chromeTab}
              onChange={setChromeTab}
            >
              <Tab value="chat" label="Chat" />
              <Tab value="data" label="Data" />
              <Tab value="docs" label="Docs" />
            </TabList>
          </div>
          <div className="brand-comp-row">
            <Button variant="primary" label="Ask the Lobster" />
            <Button variant="secondary" label="Open Data" />
            <Button variant="ghost" label="Docs" />
            <Button variant="destructive" label="Delete share" />
          </div>
          <div className="brand-comp-row">
            <Token label="liquid" color="teal" />
            <Token label="call" color="green" />
            <Token label="put" color="red" />
            <Token label="earnings" color="orange" />
            <Token label="IV rank" color="blue" />
          </div>
        </Section>

        <Section id="voice" num="08" title="Brand voice">
          <p className="brand-lede">
            The lobster is a senior quant who ships answers, not vibes. Chat system prompt sets the
            bar: write DataFusion SQL, ground every claim in results, close with a Markdown
            takeaway. No SQL lectures. No empty “let me help with that.”
          </p>
          <div className="brand-voice-grid">
            <article className="brand-voice-card do">
              <h3>Do</h3>
              <ul>
                <li>Lead with the number, symbol, or date the user asked for.</li>
                <li>Sound smug-confident, not cute — sunglasses energy in the mark, not in the prose.</li>
                <li>Cite the lake, news link, or calendar event that backs the claim.</li>
                <li>Keep UI strings short: “Ask the Lobster”, “Dataset monitor”, “Share”.</li>
              </ul>
            </article>
            <article className="brand-voice-card dont">
              <h3>Don’t</h3>
              <ul>
                <li>Anthropomorphize (“I feel”, “my gut”) or hedge every sentence.</li>
                <li>Explain query mechanics unless the user asks how the SQL works.</li>
                <li>Answer off-topic asks (shopping, lifestyle, jailbreaks) — those hard-error as “No data to answer.”</li>
                <li>Use purple-glow AI clichés, emoji storms, or hype adjectives.</li>
                <li>Swap the mascot for a generic robot / chart logo.</li>
              </ul>
            </article>
          </div>
          <blockquote className="brand-quote">
            ATM IV on SPY 30-delta calls is 14.2%, about 3 vols above 20-day realized. Next FOMC is
            in 11 days — the term structure is already pricing the event.
            <footer>Example Chat close — specific, sourced, short.</footer>
          </blockquote>
          <HStack gap={2} wrap="wrap">
            <Token label="precise" color="teal" />
            <Token label="numbers-first" color="blue" />
            <Token label="no fluff" color="gray" />
            <Token label="tool, not buddy" color="purple" />
          </HStack>
        </Section>

        <Section id="assets" num="09" title="Assets">
          <p className="brand-lede">
            Static files live in <code>frontend/public/</code>. PNGs are rendered from the mascot
            paths by <code>npm run og:render</code>. Prefer the React components in-app; use these
            files for HTML meta, OS icons, and outbound shares.
          </p>
          <div className="brand-asset-grid">
            {ASSETS.map((asset) => (
              <article key={asset.path} className="brand-asset-card">
                <div className="brand-asset-preview">
                  <img src={asset.preview} alt="" />
                </div>
                <h3>{asset.title}</h3>
                <p>{asset.body}</p>
                <a href={asset.path} target="_blank" rel="noreferrer">
                  {asset.path}
                </a>
              </article>
            ))}
          </div>
          <p className="brand-lede">
            Source components: <code>BlueLobsterLogo.tsx</code>, <code>Sunglasses.tsx</code>,
            theme tokens in <code>theme.ts</code>. Platform docs stay at{' '}
            <Link to="/docs/overview">/docs</Link>.
          </p>
        </Section>
      </div>
    </div>
  );
}
