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
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import {
  deterministicShuffle,
  isNoAnswerError,
  probeRetryDelayMs,
} from './text-vs-image-runner-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');
const NOTEBOOKS = join(FRONTEND_ROOT, 'src/notebooks');
const require = createRequire(join(FRONTEND_ROOT, 'package.json'));

const API_BASE = (process.env.API_BASE ?? 'https://api-dev.lobster.mp').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MODEL = process.env.MODEL ?? 'openai/gpt-4o-mini';
const SLUG = process.env.SLUG ?? 'text-vs-image';
const INCLUDE_HYBRIDS = (process.env.INCLUDE_HYBRIDS ?? '1') !== '0';
const PROBE_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.PROBE_ATTEMPTS ?? 3) || 3));
const SOURCE_REVISION = process.env.GITHUB_SHA?.trim()
  || process.env.SOURCE_REVISION?.trim()
  || 'local';

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
import { buildTextAsImageRepresentations } from ${JSON.stringify(join(NOTEBOOKS, 'textAsImageRepresentations.ts'))};
import { buildHybridRepresentations } from ${JSON.stringify(join(NOTEBOOKS, 'hybridRepresentations.ts'))};
import { buildQuestions, scoreAnswer, SYSTEM_PROBE } from ${JSON.stringify(join(NOTEBOOKS, 'questions.ts'))};
import { EXPERIMENT_DESIGN_ID } from ${JSON.stringify(join(NOTEBOOKS, 'experiment.ts'))};
import {
  imageFootprint,
  multimodalFootprint,
  textFootprint,
} from ${JSON.stringify(join(NOTEBOOKS, 'contextFootprint.ts'))};

const universe = buildSynthUniverse();
const textReps = buildTextRepresentations(universe);
const images = [
  ...buildImageRepresentations(universe),
  ...buildTextAsImageRepresentations(universe),
];
const hybrids = buildHybridRepresentations(universe);
const questions = buildQuestions(universe);
const tickers = universe.series.map((s) => s.ticker);
const system = Array.isArray(SYSTEM_PROBE) ? SYSTEM_PROBE.join(' ') : String(SYSTEM_PROBE);

const footprints = [
  ...textReps.map((r) => textFootprint(r.id, r.body)),
  ...images.map((r) => imageFootprint(r.id, r.width, r.height)),
  ...hybrids.map((h) => multimodalFootprint(h.id, h.textContext, h.width, h.height)),
];

globalThis.__TVSI__ = {
  designId: EXPERIMENT_DESIGN_ID,
  seed: universe.seed,
  system,
  tickers,
  footprints,
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
    const error = new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 800)}`);
    error.status = res.status;
    error.retryAfter = res.headers.get('Retry-After');
    error.apiError = typeof json?.error === 'string' ? json.error : null;
    throw error;
  }
  return json;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`API_BASE=${API_BASE}`);
  console.log(`MODEL=${MODEL}`);
  console.log(`SLUG=${SLUG}`);
  console.log(`INCLUDE_HYBRIDS=${INCLUDE_HYBRIDS}`);
  console.log(`PROBE_ATTEMPTS=${PROBE_ATTEMPTS}`);

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
      `design=${payload.designId} seed=${payload.seed} textReps=${payload.textReps.length} images=${payload.images.length} hybrids=${hybrids.length} questions=${payload.questions.length}`,
    );
    for (const fp of payload.footprints ?? []) {
      console.log(
        `context ${fp.rep_id}: total=${fp.total_tokens} text=${fp.text_tokens} image=${fp.image_tokens}`
          + (fp.image_width ? ` ${fp.image_width}x${fp.image_height}` : ''),
      );
    }

    const textById = Object.fromEntries(payload.textReps.map((r) => [r.id, r]));
    const imageById = Object.fromEntries(payload.images.map((r) => [r.id, r]));
    const hybridById = Object.fromEntries(hybrids.map((r) => [r.id, r]));
    const repOrder = [
      ...payload.textReps.map((r) => r.id),
      ...payload.images.map((r) => r.id),
      ...hybrids.map((r) => r.id),
    ];

    const jobs = deterministicShuffle(
      repOrder.flatMap((repId) =>
        payload.questions.map((question) => ({ repId, question }))),
      payload.seed,
    );
    const cells = [];
    for (const { repId, question } of jobs) {
      const text = textById[repId];
      const image = imageById[repId];
      const hybrid = hybridById[repId];
      const requestBody = hybrid
        ? {
            model: MODEL,
            mode: 'multimodal',
            question: question.prompt,
            system: payload.system,
            text_context: hybrid.text_context,
            image_data_url: hybrid.data_url,
          }
        : text
          ? {
              model: MODEL,
              mode: 'text',
              question: question.prompt,
              system: payload.system,
              text_context: text.body,
            }
          : {
              model: MODEL,
              mode: 'image',
              question: question.prompt,
              system: payload.system,
              image_data_url: image.data_url,
            };
      process.stdout.write(`probe ${repId} × ${question.id}… `);
      let lastError = null;
      let attempts = 0;
      for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
        attempts = attempt;
        try {
          const result = await api('/api/admin/notebooks/probe', {
            method: 'POST',
            body: requestBody,
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
            attempts: attempt,
          });
          console.log(scored.correct ? 'ok' : 'miss', `(${result.latency_ms}ms, attempt ${attempt})`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const retryDelay = probeRetryDelayMs(error, attempt);
          if (attempt >= PROBE_ATTEMPTS || retryDelay == null) break;
          process.stdout.write(`retry ${attempt}/${PROBE_ATTEMPTS} in ${retryDelay}ms… `);
          await sleep(retryDelay);
        }
      }
      if (lastError) {
        if (isNoAnswerError(lastError)) {
          cells.push({
            rep_id: repId,
            question_id: question.id,
            status: 'done',
            answer: '[no answer]',
            correct: false,
            detail: `model returned no answer after ${attempts} attempts`,
            model: MODEL,
            attempts,
          });
          console.log('miss', `(no answer after ${attempts} attempts)`);
        } else {
          cells.push({
            rep_id: repId,
            question_id: question.id,
            status: 'error',
            error: String(lastError?.message ?? lastError),
            model: MODEL,
            attempts,
          });
          console.log('error', String(lastError?.message ?? lastError).slice(0, 200));
        }
      }
    }

    const done = cells.filter((c) => c.status === 'done');
    const correct = done.filter((c) => c.correct).length;
    console.log(`scoring: ${correct}/${done.length} correct (${cells.length} cells)`);
    const errors = cells.filter((c) => c.status === 'error');
    if (errors.length) {
      throw new Error(`refusing to publish incomplete matrix: ${errors.length}/${cells.length} probes failed`);
    }

    const representationHashes = Object.fromEntries([
      ...payload.textReps.map((rep) => [rep.id, sha256(rep.body)]),
      ...payload.images.map((rep) => [rep.id, sha256(rep.data_url)]),
      ...hybrids.map((rep) => [
        rep.id,
        sha256(`${rep.text_context}\n${rep.data_url}`),
      ]),
    ]);
    const questionsPayload = payload.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      expected: question.expected,
      kind: question.kind,
    }));
    const systemPromptHash = sha256(payload.system);
    const questionsHash = sha256(JSON.stringify(questionsPayload));
    const designFingerprint = sha256([
      payload.designId,
      '3',
      systemPromptHash,
      questionsHash,
      ...repOrder.map((id) => `${id}:${representationHashes[id]}`),
    ].join('\n'));

    const saved = await api(`/api/admin/experiments/${encodeURIComponent(SLUG)}/runs`, {
      method: 'POST',
      body: {
        experiment_slug: SLUG,
        model: MODEL,
        seed: payload.seed,
        created_by: 'github-actions:run-text-vs-image-experiment',
        results: {
          design_id: payload.designId,
          manifest: {
            runner_version: 3,
            source_revision: SOURCE_REVISION,
            system_prompt: payload.system,
            system_prompt_sha256: systemPromptHash,
            questions_sha256: questionsHash,
            representation_sha256: representationHashes,
            design_fingerprint_sha256: designFingerprint,
            execution_order: jobs.map(({ repId, question }) => `${repId}::${question.id}`),
            max_probe_attempts: PROBE_ATTEMPTS,
          },
          questions: questionsPayload,
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
          rep_footprints: payload.footprints ?? [],
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
    const list = await api(
      `/api/experiments/${encodeURIComponent(SLUG)}/runs?design_id=${encodeURIComponent(payload.designId)}`,
    );
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
