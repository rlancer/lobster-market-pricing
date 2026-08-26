#!/usr/bin/env node
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = join(__dirname, '..');
const DEFAULT_API_BASE = 'https://api-dev.lobster.mp';
const DEFAULT_DESIGN_ID = 'text-vs-image-v3';

export function selectComparableRuns(items, designId) {
  const candidates = items
    .filter((run) =>
      run.design_id === designId
      && run.matrix_complete
      && run.cells_done > 0
      && run.cells_done === run.cells_total)
    .sort((a, b) => b.created_at - a.created_at);
  const cohort = candidates[0];
  if (!cohort) return [];

  const seenModels = new Set();
  return candidates.filter((run) => {
    if (run.seed !== cohort.seed) return false;
    if (run.manifest_fingerprint !== cohort.manifest_fingerprint) return false;
    if (seenModels.has(run.model)) return false;
    seenModels.add(run.model);
    return true;
  });
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function staticImage(image, designId) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(image.data_url);
  if (!match) throw new Error(`image ${image.id} is not a supported base64 data URL`);
  const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  const safeId = image.id.replace(/[^a-zA-Z0-9_-]/g, '-');
  const fileName = `${safeId}.${extension}`;
  return {
    fileName,
    bytes: Buffer.from(match[2], 'base64'),
    publicUrl: `/generated/text-vs-image/${designId}/${fileName}`,
  };
}

export async function fetchExperimentSnapshot({
  apiBase = DEFAULT_API_BASE,
  designId = DEFAULT_DESIGN_ID,
  fetchImpl = fetch,
  generatedAt = new Date().toISOString(),
} = {}) {
  const base = apiBase.replace(/\/$/, '');
  const listUrl = `${base}/api/experiments/text-vs-image/runs?limit=50&design_id=${
    encodeURIComponent(designId)
  }`;
  const listed = await fetchJson(fetchImpl, listUrl);
  const items = selectComparableRuns(listed.items ?? [], designId);
  if (!items.length) {
    throw new Error(`no complete ${designId} experiment runs found at ${base}`);
  }

  const modelRuns = await Promise.all(items.map((summary, index) =>
    fetchJson(
      fetchImpl,
      `${base}/api/experiments/text-vs-image/runs/${encodeURIComponent(summary.id)}`
        + `?images=${index === 0 ? 1 : 0}&design_id=${encodeURIComponent(designId)}`,
    )));

  const imageFiles = [];
  for (const run of modelRuns) {
    run.images = (run.images ?? []).map((image) => {
      const materialized = staticImage(image, designId);
      imageFiles.push(materialized);
      return { ...image, data_url: materialized.publicUrl };
    });
  }

  return {
    snapshot: {
      generated_at: generatedAt,
      design_id: designId,
      run_schema_version: listed.run_schema_version ?? null,
      items,
      model_runs: modelRuns,
    },
    imageFiles,
  };
}

export function writeExperimentSnapshot({ snapshot, imageFiles }) {
  const snapshotPath = join(
    FRONTEND_ROOT,
    'src/generated/textVsImageSnapshot.json',
  );
  const imageDir = join(
    FRONTEND_ROOT,
    `public/generated/text-vs-image/${snapshot.design_id}`,
  );
  mkdirSync(dirname(snapshotPath), { recursive: true });
  rmSync(imageDir, { recursive: true, force: true });
  mkdirSync(imageDir, { recursive: true });
  for (const image of imageFiles) {
    writeFileSync(join(imageDir, image.fileName), image.bytes);
  }
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { snapshotPath, imageDir };
}

async function main() {
  const apiBase = process.env.API_BASE ?? process.env.VITE_API_BASE ?? DEFAULT_API_BASE;
  const designId = process.env.DESIGN_ID ?? DEFAULT_DESIGN_ID;
  const materialized = await fetchExperimentSnapshot({ apiBase, designId });
  const output = writeExperimentSnapshot(materialized);
  console.log(
    `Materialized ${materialized.snapshot.model_runs.length} ${designId} model runs `
      + `and ${materialized.imageFiles.length} images from ${apiBase}`,
  );
  console.log(`Snapshot: ${output.snapshotPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
