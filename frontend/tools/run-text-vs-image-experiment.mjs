#!/usr/bin/env node
/**
 * Headless text-vs-image experiment runner.
 *
 * Bundles the notebook modules for Chromium (canvas PNGs), probes via the
 * Worker admin endpoint, scores answers, and publishes a server-saved run.
 *
 * Env:
 *   ADMIN_TOKEN  — Bearer for /api/admin/* (required)
 *   API_BASE     — Worker origin (default https://api-dev.lobster.mp)
 *   MODEL        — OpenRouter model slug (default openai/gpt-4o-mini)
 *   SLUG         — experiment slug (default text-vs-image)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');
const NOTEBOOKS = join(FRONTEND_ROOT, 'src/notebooks');
const require = createRequire(join(FRONTEND_ROOT, 'package.json'));

const API_BASE = (process.env.API_BASE ?? 'https://api-dev.lobster.mp').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini';
const SLUG = process.env.SLUG ?? 'text-vs-image';
const INCLUDE_HYBRIDS = (process.env.INCLUDE_HYBRIDS ?? '1') !== '0';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required');
  process.exit(1);
}

async function bundleBrowserHarness() {
  const esbuild = await import(pathToFileURL(require.resolve('esbuild')).href);
  const dir = mkdtempSync(join(tmpdir(), 'tvsi-'));
  const entry = join(dir, 'entry.ts');
  const outfile = join(dir, 'harness.js');

  writeFileSync(
    entry,
    `
import { buildSynthUniverse } from ${JSON.stringify(join(NOTEBOOKS, 'syntheticSeries.ts'))};
import { buildTextRepresentations } from ${JSON.stringify(join(NOTEBOOKS, 'textRepresentations.ts'))};
import { buildImageRepresentations } from ${JSON.stringify(join(NOTEBOOKS, 'imageRepresentations.ts'))};
import { buildHybridRepresentations } from ${JSON.stringify(join(NOTEBOOKS, 'hybridRepresentations.ts'))};
import { buildQuestions, scoreAnswer, SYSTEM_PROBE } from ${JSON.stringify(join(NOTEBOOKS, 'questions.ts'))};

const universe = buildSynthUniverse();
const textReps = buildTextRepresentations(universe);
const images = buildImageRepresentations(universe);
const hybrids = buildHybridRepresentations(universe);
const questions = buildQuestions(universe);
const tickers = universe.series.map((s) => s.ticker);
const system = Array.isArray(SYSTEM_PROBE) ? SYSTEM_PROBE.join(' ') : String(SYSTEM_PROBE);

globalThis.__TVSI__ = {
  seed: universe.seed,
  system,
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
  hybrids: hybrids.map((h) => ({
    id: h.id,
    label: h.label,
    description: h.description,
    width: h.width,
    height: h.height,
    data_url: h.dataUrl,
    text_context: h.textContext,
    approx_tokens: h.approxTokens,
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
    const scored = scoreAnswer(q, answer, tickers);
    return { correct: scored.correct, detail: scored.detail };
  },
};
`,
  );

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile,
    logLevel: 'silent',
  });
  if (result.errors?.length) {
    throw new Error(`esbuild errors: ${JSON.stringify(result.errors)}`);
  }
  return { dir, outfile };
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
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
  return json;
}

async function main() {
  console.log(`API_BASE=${API_BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`SLUG=${SLUG}`);
  console.log(`INCLUDE_HYBRIDS=${INCLUDE_HYBRIDS}`);

  const harness = await bundleBrowserHarness();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: harness.outfile });
    const payload = await page.evaluate(() => globalThis.__TVSI__);
    if (!payload?.images?.length || !payload?.questions?.length) {
      throw new Error('harness did not produce images/questions');
    }
    const hybrids = INCLUDE_HYBRIDS ? (payload.hybrids ?? []) : [];
    if (!INCLUDE_HYBRIDS) {
      console.log('INCLUDE_HYBRIDS=0 — skipping textless color-keyed multimodal reps');
    }
    console.log(
      `seed=${payload.seed} textReps=${payload.textReps.length} images=${payload.images.length} hybrids=${hybrids.length} questions=${payload.questions.length}`,
    );

    const textById = Object.fromEntries(payload.textReps.map((r) => [r.id, r]));
    const imageById = Object.fromEntries(payload.images.map((r) => [r.id, r]));
    const hybridById = Object.fromEntries(hybrids.map((r) => [r.id, r]));
    const repOrder = [
      ...payload.textReps.map((r) => r.id),
      ...payload.images.map((r) => r.id),
      ...hybrids.map((r) => r.id),
    ];

    const cells = [];
    for (const repId of repOrder) {
      for (const question of payload.questions) {
        const text = textById[repId];
        const image = imageById[repId];
        const hybrid = hybridById[repId];
        process.stdout.write(`probe ${repId} × ${question.id}… `);
        try {
          const result = hybrid
            ? await api('/api/admin/notebooks/probe', {
                method: 'POST',
                body: {
                  model: MODEL,
                  mode: 'multimodal',
                  question: question.prompt,
                  system: payload.system,
                  text_context: hybrid.text_context,
                  image_data_url: hybrid.data_url,
                },
              })
            : text
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
          console.log('error', String(error?.message ?? error).slice(0, 200));
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
          text_reps: [
            ...payload.textReps,
            ...hybrids.map((h) => ({
              id: h.id,
              label: h.label,
              description: h.description,
              approx_tokens: h.approx_tokens,
              body: h.text_context,
            })),
          ],
          cells,
          rep_order: repOrder,
        },
        images: [
          ...payload.images,
          ...hybrids.map((h) => ({
            id: h.id,
            label: h.label,
            description: h.description,
            width: h.width,
            height: h.height,
            data_url: h.data_url,
          })),
        ],
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
