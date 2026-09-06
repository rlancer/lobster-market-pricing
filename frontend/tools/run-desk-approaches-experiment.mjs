#!/usr/bin/env node
/**
 * Headless desk-approaches experiment runner.
 *
 * Probes each approach × as-of case via the Worker admin endpoint, then
 * publishes a server-saved run (no images).
 *
 * Env:
 *   ADMIN_TOKEN  — Bearer for /api/admin/* (required)
 *   API_BASE     — Worker origin (default https://api-dev.lobster.mp)
 *   MODEL        — OpenRouter model slug (default: live Chat COPILOT_MODEL,
 *                  currently deepseek/deepseek-v4-flash-0731)
 */
import { createHash } from 'node:crypto';

const API_BASE = (process.env.API_BASE?.trim() || 'https://api-dev.lobster.mp').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MODEL = process.env.MODEL?.trim() || 'deepseek/deepseek-v4-flash-0731';
const SLUG = 'desk-approaches';
const DESIGN_ID = 'desk-approaches-v1';
const RUNNER_VERSION = 1;
const PROBE_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.PROBE_ATTEMPTS ?? 2) || 2));
const SOURCE_REVISION = process.env.GITHUB_SHA?.trim()
  || process.env.SOURCE_REVISION?.trim()
  || 'local';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required');
  process.exit(1);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`API ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function main() {
  const design = await api('/api/experiments/desk-approaches/design');
  if (design.design_id !== DESIGN_ID) {
    throw new Error(`unexpected design_id ${design.design_id}`);
  }

  const systemPrompt = [
    design.as_of_rules,
    'End with a JSON verdict of lean_5d / lean_20d.',
    'Approaches differ only in session structure (solo / role-play desk / shared session / fresh sessions).',
  ].join('\n');

  const questions = design.cases.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    expected: `5d=${row.expected_5d},20d=${row.expected_20d}`,
    kind: 'direction',
  }));
  const textReps = design.approaches.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    body: `${row.id}\n${row.label}\n${row.session_mode}\n${row.description}`,
  }));
  const repOrder = textReps.map((r) => r.id);
  const representationHashes = Object.fromEntries(textReps.map((r) => [r.id, sha256(r.body)]));
  const snapshotHashes = Object.fromEntries(
    design.cases.map((row) => [row.id, sha256(row.snapshot_text)]),
  );

  const cells = [];
  const executionOrder = [];
  for (const approach of design.approaches) {
    for (const experimentCase of design.cases) {
      const key = `${approach.id}::${experimentCase.id}`;
      executionOrder.push(key);
      process.stdout.write(`probe ${key}… `);
      let lastError = null;
      for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
        try {
          const result = await api('/api/admin/experiments/desk-approaches/probe', {
            method: 'POST',
            body: {
              model: MODEL,
              approach_id: approach.id,
              case_id: experimentCase.id,
            },
          });
          const score = result.score;
          const run = result.run;
          cells.push({
            rep_id: approach.id,
            question_id: experimentCase.id,
            status: 'done',
            answer: (run.answer ?? '').slice(0, 4000),
            correct: Boolean(score.correct),
            detail: score.detail,
            latency_ms: run.latency_ms,
            model: result.model ?? MODEL,
            attempts: attempt,
            lean_5d: run.verdict?.lean_5d,
            lean_20d: run.verdict?.lean_20d,
            actual_5d: score.actual_5d,
            actual_20d: score.actual_20d,
            correct_5d: score.correct_5d,
            correct_20d: score.correct_20d,
            session_count: run.session_count,
          });
          console.log(
            score.correct ? 'ok' : 'miss',
            `(sessions=${run.session_count}, ${run.latency_ms}ms, attempt ${attempt})`,
          );
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= PROBE_ATTEMPTS) break;
          const delay = 4_000 * attempt;
          process.stdout.write(`retry ${attempt}/${PROBE_ATTEMPTS} in ${delay}ms… `);
          await sleep(delay);
        }
      }
      if (lastError) {
        cells.push({
          rep_id: approach.id,
          question_id: experimentCase.id,
          status: 'done',
          answer: '[no answer]',
          correct: false,
          detail: String(lastError.message ?? lastError).slice(0, 500),
          model: MODEL,
          attempts: PROBE_ATTEMPTS,
          session_count: approach.id === 'desk_fresh_sessions' ? 5 : 1,
        });
        console.log('fail', lastError.message ?? lastError);
      }
    }
  }

  const snapshotFingerprint = questions
    .map((q) => `${q.id}:${snapshotHashes[q.id]}`)
    .join('\n');
  const fingerprint = sha256([
    DESIGN_ID,
    String(RUNNER_VERSION),
    sha256(systemPrompt),
    sha256(JSON.stringify(questions)),
    snapshotFingerprint,
    ...repOrder.map((id) => `${id}:${representationHashes[id]}`),
  ].join('\n'));

  const payload = {
    experiment_slug: SLUG,
    model: MODEL,
    seed: 0x4d45534b,
    results: {
      design_id: DESIGN_ID,
      manifest: {
        runner_version: RUNNER_VERSION,
        source_revision: SOURCE_REVISION,
        system_prompt: systemPrompt,
        system_prompt_sha256: sha256(systemPrompt),
        questions_sha256: sha256(JSON.stringify(questions)),
        representation_sha256: representationHashes,
        snapshot_sha256: snapshotHashes,
        design_fingerprint_sha256: fingerprint,
        execution_order: executionOrder,
        max_probe_attempts: PROBE_ATTEMPTS,
      },
      questions,
      text_reps: textReps,
      cells,
      rep_order: repOrder,
    },
    images: [],
  };

  const saved = await api(`/api/admin/experiments/${SLUG}/runs`, {
    method: 'POST',
    body: payload,
  });
  console.log('saved', saved.run?.id ?? saved);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
