#!/usr/bin/env node
/**
 * Headless text-vs-image experiment runner.
 *
 * Builds the synthetic panel + chart PNGs in Chromium (same canvas code as the
 * UI), probes OpenRouter via the Worker admin endpoint, scores answers, and
 * publishes a server-saved run so the public Experiments page can load it.
 *
 * Env:
 *   ADMIN_TOKEN   — Bearer for /api/admin/* (required)
 *   API_BASE      — Worker origin (default https://api-dev.lobster.mp)
 *   MODEL         — OpenRouter model slug (default openai/gpt-4o-mini)
 *   SLUG          — experiment slug (default text-vs-image)
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');
const NOTEBOOKS = join(FRONTEND_ROOT, 'src/notebooks');

const API_BASE = (process.env.API_BASE ?? 'https://api-dev.lobster.mp').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini';
const SLUG = process.env.SLUG ?? 'text-vs-image';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required');
  process.exit(1);
}

function bundleBrowserHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'tvsi-'));
  const entry = join(dir, 'entry.ts');
  const outfile = join(dir, 'harness.js');
  writeFileSync(
    entry,
    `
import { buildSynthUniverse } from '${NOTEBOOKS}/syntheticSeries.ts';
import { buildTextRepresentations } from '${NOTEBOOKS}/textRepresentations.ts';
import { buildImageRepresentations } from '${NOTEBOOKS}/imageRepresentations.ts';
import { buildQuestions, scoreAnswer, SYSTEM_PROBE } from '${NOTEBOOKS}/questions.ts';

const universe = buildSynthUniverse();
const textReps = buildTextRepresentations(universe);
const images = buildImageRepresentations(universe);
const questions = buildQuestions(universe);
const tickers = universe.series.map((s) => s.ticker);

globalThis.__TVSI__ = {
  seed: universe.seed,
  system: SYSTEM_PROBE,
  tickers,
  textReps: textReps.map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    approx_tokens: r.approxTokens,
    body: r.body,
  })),
  images: images.map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
    width: r.width,
    height: r.height,
    data_url: r.dataUrl,
  })),
  questions: questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    expected: String(q.expected),
    kind: q.kind,
  })),
  score(questionId, answer) {
    const q = questions.find((x) => x.id === questionId);
    if (!q) return { correct: false, detail: 'unknown question' };
    return scoreAnswer(q, answer, tickers);
  },
};
`,
  );

  const require = createRequire(join(FRONTEND_ROOT, 'package.json'));
  let esbuildBin;
  try {
    esbuildBin = require.resolve('esbuild/bin/esbuild');
  } catch {
    esbuildBin = null;
  }

  const args = [
    entry,
    '--bundle',
    '--format=iife',
    '--platform=browser',
    `--outfile=${outfile}`,
  ];
  const result = esbuildBin
    ? spawnSync(process.execPath, [esbuildBin, ...args], { encoding: 'utf8' })
    : spawnSync('npx', ['esbuild', ...args], { encoding: 'utf8', cwd: FRONTEND_ROOT });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error('esbuild failed to bundle notebook harness');
  }
  return { dir, outfile, js: readFileSync(outfile, 'utf8') };
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function main() {
  console.log(`API_BASE=${API_BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`SLUG=${SLUG}`);

  const harness = bundleBrowserHarness();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: harness.js });
    const payload = await page.evaluate(() => globalThis.__TVSI__);
    if (!payload?.images?.length || !payload?.questions?.length) {
      throw new Error('harness did not produce images/questions');
    }
    console.log(
      `seed=${payload.seed} textReps=${payload.textReps.length} images=${payload.images.length} questions=${payload.questions.length}`,
    );

    const textById = Object.fromEntries(payload.textReps.map((r) => [r.id, r]));
    const imageById = Object.fromEntries(payload.images.map((r) => [r.id, r]));
    const repOrder = [
      ...payload.textReps.map((r) => r.id),
      ...payload.images.map((r) => r.id),
    ];

    const cells = [];
    for (const repId of repOrder) {
      for (const question of payload.questions) {
        const text = textById[repId];
        const image = imageById[repId];
        process.stdout.write(`probe ${repId} × ${question.id}… `);
        try {
          const result = text
            ? await api('/api/admin/notebooks/probe', {
                method: 'POST',
                body: {
                  model: MODEL,
                  mode: 'text',
                  question: question.prompt,
                  system: payload.system,
                  text_context: text.body,
                },
              })
            : await api('/api/admin/notebooks/probe', {
                method: 'POST',
                body: {
                  model: MODEL,
                  mode: 'image',
                  question: question.prompt,
                  system: payload.system,
                  image_data_url: image.data_url,
                },
              });
          const scored = await page.evaluate(
            ({ questionId, answer }) => globalThis.__TVSI__.score(questionId, answer),
            { questionId: question.id, answer: result.answer },
          );
          cells.push({
            rep_id: repId,
            question_id: question.id,
            status: 'done',
            answer: result.answer,
            correct: scored.correct,
            detail: scored.detail,
            latency_ms: result.latency_ms,
            model: result.model ?? MODEL,
          });
          console.log(scored.correct ? 'ok' : 'miss', `(${result.latency_ms}ms)`);
        } catch (error) {
          cells.push({
            rep_id: repId,
            question_id: question.id,
            status: 'error',
            error: String(error?.message ?? error),
            model: MODEL,
          });
          console.log('error', String(error?.message ?? error).slice(0, 160));
        }
      }
    }

    const done = cells.filter((c) => c.status === 'done');
    const correct = done.filter((c) => c.correct).length;
    console.log(`scoring: ${correct}/${done.length} correct (${cells.length} cells)`);

    const saved = await api(`/api/admin/experiments/${encodeURIComponent(SLUG)}/runs`, {
      method: 'POST',
      body: {
        experiment_slug: SLUG,
        model: MODEL,
        seed: payload.seed,
        created_by: 'github-actions:run-text-vs-image-experiment',
        results: {
          questions: payload.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            expected: q.expected,
          })),
          text_reps: payload.textReps,
          cells,
          rep_order: repOrder,
        },
        images: payload.images,
      },
    });

    console.log(`published run id=${saved.run?.id} model=${saved.run?.model}`);
    const list = await api(`/api/experiments/${encodeURIComponent(SLUG)}/runs`);
    console.log(
      'runs:',
      (list.items ?? [])
        .map((r) => `${r.id.slice(0, 8)} ${r.model} ${r.cells_correct}/${r.cells_done}`)
        .join(' | ') || '(none)',
    );
  } finally {
    await browser.close();
    rmSync(harness.dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
