import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchExperimentSnapshot,
  selectComparableRuns,
} from './materialize-text-vs-image-snapshot.mjs';

const summary = (overrides = {}) => ({
  id: 'run-a',
  model: 'model/a',
  seed: 42,
  created_at: 10,
  design_id: 'text-vs-image-v3',
  manifest_fingerprint: 'fingerprint-a',
  matrix_complete: true,
  cells_done: 72,
  cells_total: 72,
  ...overrides,
});

test('selectComparableRuns keeps newest complete run per model in one cohort', () => {
  const selected = selectComparableRuns([
    summary({ id: 'new-a', created_at: 20 }),
    summary({ id: 'old-a', created_at: 10 }),
    summary({ id: 'b', model: 'model/b', created_at: 19 }),
    summary({ id: 'wrong-seed', model: 'model/c', seed: 7, created_at: 18 }),
    summary({
      id: 'wrong-manifest',
      model: 'model/d',
      manifest_fingerprint: 'fingerprint-b',
      created_at: 17,
    }),
    summary({ id: 'partial', model: 'model/e', cells_done: 71, created_at: 16 }),
  ], 'text-vs-image-v3');
  assert.deepEqual(selected.map((run) => run.id), ['new-a', 'b']);
});

test('fetchExperimentSnapshot embeds runs and extracts first-run images', async () => {
  const items = [
    summary({ id: 'run-a' }),
    summary({ id: 'run-b', model: 'model/b', created_at: 9 }),
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/runs?')) {
      return Response.json({ items, run_schema_version: 2 });
    }
    const id = url.includes('run-a') ? 'run-a' : 'run-b';
    return Response.json({
      id,
      model: id === 'run-a' ? 'model/a' : 'model/b',
      results: { design_id: 'text-vs-image-v3' },
      images: id === 'run-a'
        ? [{
            id: 'overlay',
            label: 'Overlay',
            description: 'Lines',
            width: 10,
            height: 10,
            data_url: 'data:image/png;base64,aGVsbG8=',
          }]
        : [],
    });
  };

  const materialized = await fetchExperimentSnapshot({
    apiBase: 'https://api.example',
    designId: 'text-vs-image-v3',
    fetchImpl,
    generatedAt: '2026-08-26T12:00:00.000Z',
  });

  assert.equal(materialized.snapshot.model_runs.length, 2);
  assert.equal(materialized.imageFiles.length, 1);
  assert.equal(materialized.imageFiles[0].bytes.toString(), 'hello');
  assert.equal(
    materialized.snapshot.model_runs[0].images[0].data_url,
    '/generated/text-vs-image/text-vs-image-v3/overlay.png',
  );
  assert.match(calls[1], /images=1/);
  assert.match(calls[2], /images=0/);
});
