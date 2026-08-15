/**
 * Renders brand OG / social share images via Playwright Chromium.
 * Source art is the BlueLobsterLogo paths with dark-theme brand tokens.
 *
 * Usage: node frontend/scripts/render-og.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../public');
const tmpDir = join(__dirname, '../.og-tmp');

mkdirSync(tmpDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const COLORS = {
  body: '#07131F',
  surface: '#0C1C29',
  card: '#102432',
  text: '#EAF7F3',
  muted: '#8EA8AA',
  accent: '#35D0BA',
  accentMuted: '#35D0BA1F',
  iconBlue: '#9EB7FF',
  borderBlue: '#6D9CFE',
  border: '#1B3946',
};

/** Exact paths from BlueLobsterLogo.tsx — dark-theme tokens inlined. */
function lobsterSvg(size = 96) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="${size}" height="${size}" aria-hidden="true">
  <g fill="none" stroke="${COLORS.iconBlue}" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5">
    <path d="M41 26C33 17 23 12 13 14" />
    <path d="M55 26C63 17 73 12 83 14" />
    <path d="M37 37C31 34 27 33 23 34" />
    <path d="M59 37C65 34 69 33 73 35" />
    <path d="M38 48L27 53M58 48L68 52" />
  </g>
  <g fill="${COLORS.borderBlue}" stroke="${COLORS.iconBlue}" stroke-linejoin="round" stroke-width="2.5">
    <path d="M36 40C30 30 22 24 13 25C4 26 1 36 5 44C10 54 22 56 31 49L38 44L36 40ZM12 33C17 30 23 33 27 39C21 37 16 39 11 43C8 40 8 35 12 33Z" fill-rule="evenodd" />
    <path d="M60 40C65 32 72 27 79 29C87 31 90 39 86 46C82 53 73 53 66 48L58 44L60 40ZM78 36C74 34 70 36 67 40C72 39 76 41 79 44C82 41 82 38 78 36Z" fill-rule="evenodd" />
    <path d="M37 29C39 23 43 20 48 20C53 20 57 23 59 29L58 61C56 69 52 73 48 73C44 73 40 69 38 61L37 29Z" />
    <path d="M39 65C37 74 30 81 18 87C29 90 40 87 46 82L48 91L52 81C57 84 63 85 69 83C61 77 57 71 56 65C51 70 44 70 39 65Z" />
  </g>
  <g fill="${COLORS.card}" stroke="${COLORS.iconBlue}" stroke-linejoin="round" stroke-width="1.8">
    <path d="M38 41L43 38L48 44L53 38L58 41L57 60C56 65 53 69 48 71C43 69 40 65 39 60L38 41Z" />
  </g>
  <g fill="none" stroke="${COLORS.iconBlue}" stroke-linecap="round" stroke-width="1.5">
    <path d="M43 39L48 45L53 39M48 45V68" />
  </g>
  <rect x="51" y="48" width="4.5" height="2.5" rx="1.25" fill="${COLORS.accent}" />
  <g fill="${COLORS.body}" stroke="${COLORS.text}" stroke-linejoin="round" stroke-width="1.5">
    <rect x="39" y="27" width="8" height="6" rx="2" />
    <rect x="49" y="27" width="8" height="6" rx="2" />
    <path d="M47 29.5H49M39 29L37 28M57 29L59 28" fill="none" />
  </g>
  <g fill="none" stroke="${COLORS.iconBlue}" stroke-linecap="round" stroke-width="1.2">
    <path d="M41 29L43 28M51 29L53 28" />
  </g>
  <path d="M42 36Q48 42 54 36" fill="none" stroke="${COLORS.body}" stroke-linecap="round" stroke-width="2.5" />
</svg>`;
}

/** Brand glasses from Sunglasses.tsx / favicon — dark-theme tokens inlined. */
function sunglassesSvg(width = 112, height = 48) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="34 24 28 12" width="${width}" height="${height}" aria-hidden="true">
  <g fill="${COLORS.body}" stroke="${COLORS.text}" stroke-linejoin="round" stroke-width="1.5">
    <rect x="39" y="27" width="8" height="6" rx="2" />
    <rect x="49" y="27" width="8" height="6" rx="2" />
    <path d="M47 29.5H49M39 29L37 28M57 29L59 28" fill="none" />
  </g>
  <g fill="none" stroke="${COLORS.iconBlue}" stroke-linecap="round" stroke-width="1.2">
    <path d="M41 29L43 28M51 29L53 28" />
  </g>
</svg>`;
}

function ogHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 1200px;
      height: 630px;
      overflow: hidden;
      background: ${COLORS.body};
    }
    .stage {
      position: relative;
      width: 1200px;
      height: 630px;
      overflow: hidden;
      display: grid;
      place-items: center;
      background:
        radial-gradient(ellipse 55% 75% at 50% 48%, ${COLORS.accentMuted} 0%, transparent 58%),
        radial-gradient(ellipse 40% 55% at 72% 28%, #9EB7FF18 0%, transparent 50%),
        linear-gradient(145deg, ${COLORS.body} 0%, ${COLORS.surface} 48%, #0A1A28 100%);
    }
    .ring {
      position: absolute;
      width: 540px;
      height: 540px;
      border-radius: 50%;
      border: 1px solid ${COLORS.border};
      opacity: 0.55;
    }
    .ring::before {
      content: "";
      position: absolute;
      inset: 42px;
      border-radius: 50%;
      border: 1px dashed ${COLORS.borderBlue}55;
    }
    .mascot {
      position: relative;
      width: 480px;
      height: 480px;
      display: grid;
      place-items: center;
      filter: drop-shadow(0 24px 48px #000A1099);
    }
    .mascot svg { width: 440px; height: 440px; }
  </style>
</head>
<body>
  <div class="stage">
    <div class="ring" aria-hidden="true"></div>
    <div class="mascot">${lobsterSvg(440)}</div>
  </div>
</body>
</html>`;
}

function squareHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1200px; height: 1200px; overflow: hidden; background: ${COLORS.body}; }
    .stage {
      position: relative;
      width: 1200px;
      height: 1200px;
      background:
        radial-gradient(ellipse 70% 50% at 50% 50%, ${COLORS.accentMuted} 0%, transparent 58%),
        radial-gradient(ellipse 45% 35% at 68% 32%, #9EB7FF18 0%, transparent 50%),
        linear-gradient(160deg, ${COLORS.body} 0%, ${COLORS.surface} 100%);
      display: grid;
      place-items: center;
    }
    .ring {
      position: absolute;
      width: 820px;
      height: 820px;
      border-radius: 50%;
      border: 1px solid ${COLORS.border};
    }
    .ring::before {
      content: "";
      position: absolute;
      inset: 56px;
      border-radius: 50%;
      border: 1px dashed ${COLORS.borderBlue}55;
    }
    .mark {
      position: relative;
      display: grid;
      place-items: center;
      filter: drop-shadow(0 28px 56px #000A10AA);
    }
    .mark svg { width: 720px; height: 308px; }
  </style>
</head>
<body>
  <div class="stage">
    <div class="ring" aria-hidden="true"></div>
    <div class="mark">${sunglassesSvg(720, 308)}</div>
  </div>
</body>
</html>`;
}

function iconHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 512px; height: 512px; overflow: hidden; background: ${COLORS.body}; }
    .stage {
      width: 512px;
      height: 512px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 50% 48%, ${COLORS.accentMuted} 0%, transparent 55%),
        ${COLORS.body};
    }
    svg { width: 360px; height: 154px; }
  </style>
</head>
<body>
  <div class="stage">${sunglassesSvg(360, 154)}</div>
</body>
</html>`;
}

const jobs = [
  { name: 'og', html: ogHtml(), w: 1200, h: 630, out: join(publicDir, 'og.png') },
  { name: 'og-square', html: squareHtml(), w: 1200, h: 1200, out: join(publicDir, 'og-square.png') },
  { name: 'apple-touch-icon', html: iconHtml(), w: 512, h: 512, out: join(publicDir, 'apple-touch-icon.png') },
];

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const job of jobs) {
    const htmlPath = join(tmpDir, `${job.name}.html`);
    writeFileSync(htmlPath, job.html);
    const page = await browser.newPage({
      viewport: { width: job.w, height: job.h, deviceScaleFactor: 1 },
    });
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle', timeout: 15_000 });
    await page.screenshot({ path: job.out, type: 'png', omitBackground: false });
    await page.close();
    console.log(`wrote ${job.out}`);
  }
} finally {
  await browser.close();
}

writeFileSync(
  join(publicDir, 'og.svg'),
  `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="Lobster MP mascot">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${COLORS.body}"/>
      <stop offset="48%" stop-color="${COLORS.surface}"/>
      <stop offset="100%" stop-color="#0A1A28"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="48%" r="45%">
      <stop offset="0%" stop-color="${COLORS.accent}" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="${COLORS.accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(380 95) scale(4.6)">${lobsterSvg(96).replace(/<\/?svg[^>]*>/g, '')}</g>
</svg>
`,
);

try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup failures
}

console.log('OG assets ready.');
