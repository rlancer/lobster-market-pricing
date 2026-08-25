/**
 * Cross-model conclusion for the text-vs-image experiment.
 * Aggregates per-representation accuracy across published runs (models × seeds)
 * so visitors can see which encoding wins without opening each run separately.
 */

import { REPRESENTATION_LABELS, type RepresentationId } from './experiment.ts';
import { isChartHostileQuestionId } from './questions.ts';

export type RepFamily =
  | 'precomputed_text'
  | 'raw_text'
  | 'labeled_image'
  | 'hybrid';

export interface RunRepAccuracy {
  rep_id: string;
  correct: number;
  done: number;
}

export interface RunCellForConclusion {
  rep_id: string;
  question_id: string;
  status: string;
  correct?: boolean;
}

export interface RunSummaryForConclusion {
  id: string;
  model: string;
  seed?: number;
  created_at: number;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  rep_accuracy: RunRepAccuracy[];
  /** All-question per-rep scores excluding chart-hostile prompts (preferred for image/hybrid). */
  rep_accuracy_chart_fair?: RunRepAccuracy[];
  rep_order?: string[];
  /** When present, used to derive chart-fair scores if not precomputed. */
  cells?: RunCellForConclusion[];
}

export interface ModelRepScore {
  model: string;
  runId: string;
  seed?: number;
  correct: number;
  done: number;
  accuracy: number | null;
  /** Seeds folded into this score (1 when a single run). */
  seeds: number;
}

export interface CrossRepRow {
  repId: string;
  label: string;
  family: RepFamily;
  byModel: ModelRepScore[];
  /** Mean accuracy across model aggregates that tested this rep (null if none). */
  meanAccuracy: number | null;
  modelsTested: number;
  /** True when image/hybrid means exclude chart-hostile questions. */
  chartFair: boolean;
}

export interface FamilyScore {
  family: RepFamily;
  label: string;
  meanAccuracy: number | null;
  modelsTested: number;
  chartFair: boolean;
}

export interface CrossModelConclusion {
  models: Array<{
    model: string;
    runId: string;
    seed?: number;
    created_at: number;
    cells_correct: number;
    cells_done: number;
    cells_total: number;
    overallAccuracy: number | null;
    seeds: number;
  }>;
  rows: CrossRepRow[];
  families: FamilyScore[];
  winningRep: CrossRepRow | null;
  winningFamily: FamilyScore | null;
  seedCount: number;
  seeds: number[];
  /** One-paragraph visitor-facing takeaway. */
  summary: string;
}

const FAMILY_LABELS: Record<RepFamily, string> = {
  precomputed_text: 'Precomputed text (stats / tool summary)',
  raw_text: 'Raw closes CSV',
  labeled_image: 'Labeled chart images',
  hybrid: 'Textless chart + color key',
};

const FAMILY_ORDER: RepFamily[] = [
  'precomputed_text',
  'raw_text',
  'labeled_image',
  'hybrid',
];

export function repFamily(repId: string): RepFamily {
  if (repId.endsWith('_color_keyed') || repId.includes('textless')) return 'hybrid';
  if (repId === 'csv_closes') return 'raw_text';
  if (repId === 'tool_summary' || repId === 'stats_table') return 'precomputed_text';
  return 'labeled_image';
}

export function usesChartFairScoring(family: RepFamily): boolean {
  return family === 'labeled_image' || family === 'hybrid';
}

export function repLabel(repId: string): string {
  if (repId in REPRESENTATION_LABELS) {
    return REPRESENTATION_LABELS[repId as RepresentationId];
  }
  return repId.replace(/_/g, ' ');
}

/** Aggregate correct/done from cells, optionally skipping chart-hostile questions. */
export function accuracyFromCells(
  cells: RunCellForConclusion[],
  opts?: { chartFair?: boolean },
): RunRepAccuracy[] {
  const byRep = new Map<string, { correct: number; done: number }>();
  for (const cell of cells) {
    if (cell.status !== 'done') continue;
    if (opts?.chartFair && isChartHostileQuestionId(cell.question_id)) continue;
    const cur = byRep.get(cell.rep_id) ?? { correct: 0, done: 0 };
    cur.done += 1;
    if (cell.correct) cur.correct += 1;
    byRep.set(cell.rep_id, cur);
  }
  return [...byRep.entries()].map(([rep_id, stats]) => ({
    rep_id,
    correct: stats.correct,
    done: stats.done,
  }));
}

/** Newest complete-enough run per model (dedupes repeated publishes). */
export function pickLatestRunPerModel(
  runs: RunSummaryForConclusion[],
): RunSummaryForConclusion[] {
  const byModel = new Map<string, RunSummaryForConclusion>();
  const sorted = runs.slice().sort((a, b) => b.created_at - a.created_at);
  for (const run of sorted) {
    if (byModel.has(run.model)) continue;
    if (run.cells_done <= 0) continue;
    byModel.set(run.model, run);
  }
  return [...byModel.values()].sort((a, b) => b.created_at - a.created_at);
}

/**
 * Newest complete-enough run per (model, seed). Multiple seeds for the same
 * model are kept so conclusions can average across panels.
 */
export function pickLatestRunPerModelSeed(
  runs: RunSummaryForConclusion[],
): RunSummaryForConclusion[] {
  const byKey = new Map<string, RunSummaryForConclusion>();
  const sorted = runs.slice().sort((a, b) => b.created_at - a.created_at);
  for (const run of sorted) {
    if (run.cells_done <= 0) continue;
    const seedKey = run.seed == null ? 'unknown' : String(run.seed);
    const key = `${run.model}::${seedKey}`;
    if (byKey.has(key)) continue;
    byKey.set(key, run);
  }
  return [...byKey.values()].sort((a, b) => b.created_at - a.created_at);
}

function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function resolveRepAccuracy(
  run: RunSummaryForConclusion,
  chartFair: boolean,
): RunRepAccuracy[] {
  if (chartFair) {
    if (run.rep_accuracy_chart_fair?.length) return run.rep_accuracy_chart_fair;
    if (run.cells?.length) return accuracyFromCells(run.cells, { chartFair: true });
  }
  if (run.rep_accuracy.length) return run.rep_accuracy;
  if (run.cells?.length) return accuracyFromCells(run.cells, { chartFair: false });
  return [];
}

interface ModelAggregate {
  model: string;
  runId: string;
  seed?: number;
  created_at: number;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  seeds: number;
  /** Summed correct/done per rep across seeds. */
  repTotals: Map<string, { correct: number; done: number; chartFair: boolean }>;
  repOrder: string[];
}

function aggregateByModel(picked: RunSummaryForConclusion[]): ModelAggregate[] {
  const byModel = new Map<string, ModelAggregate>();

  for (const run of picked) {
    let agg = byModel.get(run.model);
    if (!agg) {
      agg = {
        model: run.model,
        runId: run.id,
        seed: run.seed,
        created_at: run.created_at,
        cells_correct: 0,
        cells_done: 0,
        cells_total: 0,
        seeds: 0,
        repTotals: new Map(),
        repOrder: [],
      };
      byModel.set(run.model, agg);
    }
    if (run.created_at > agg.created_at) {
      agg.created_at = run.created_at;
      agg.runId = run.id;
      agg.seed = run.seed;
    }
    agg.seeds += 1;
    agg.cells_correct += run.cells_correct;
    agg.cells_done += run.cells_done;
    agg.cells_total += run.cells_total;

    const order = run.rep_order?.length
      ? run.rep_order
      : run.rep_accuracy.map((r) => r.rep_id);
    for (const id of order) {
      if (!agg.repOrder.includes(id)) agg.repOrder.push(id);
    }

    // Merge all-question scores first, then overwrite image/hybrid with chart-fair.
    const allScores = resolveRepAccuracy(run, false);
    for (const hit of allScores) {
      const family = repFamily(hit.rep_id);
      if (usesChartFairScoring(family)) continue;
      const cur = agg.repTotals.get(hit.rep_id) ?? { correct: 0, done: 0, chartFair: false };
      cur.correct += hit.correct;
      cur.done += hit.done;
      agg.repTotals.set(hit.rep_id, cur);
    }
    const fairScores = resolveRepAccuracy(run, true);
    const fairById = new Map(fairScores.map((r) => [r.rep_id, r]));
    for (const hit of allScores) {
      const family = repFamily(hit.rep_id);
      if (!usesChartFairScoring(family)) continue;
      const fair = fairById.get(hit.rep_id) ?? hit;
      const cur = agg.repTotals.get(hit.rep_id) ?? { correct: 0, done: 0, chartFair: true };
      cur.correct += fair.correct;
      cur.done += fair.done;
      cur.chartFair = true;
      agg.repTotals.set(hit.rep_id, cur);
    }
  }

  return [...byModel.values()].sort((a, b) => b.created_at - a.created_at);
}

export function buildCrossModelConclusion(
  runs: RunSummaryForConclusion[],
): CrossModelConclusion {
  const picked = pickLatestRunPerModelSeed(runs);
  const aggregates = aggregateByModel(picked);

  const seedSet = new Set<number>();
  for (const run of picked) {
    if (run.seed != null) seedSet.add(run.seed);
  }
  const seeds = [...seedSet].sort((a, b) => a - b);

  const models = aggregates.map((r) => ({
    model: r.model,
    runId: r.runId,
    seed: r.seed,
    created_at: r.created_at,
    cells_correct: r.cells_correct,
    cells_done: r.cells_done,
    cells_total: r.cells_total,
    overallAccuracy: r.cells_done ? r.cells_correct / r.cells_done : null,
    seeds: r.seeds,
  }));

  const repIds: string[] = [];
  const seen = new Set<string>();
  for (const agg of aggregates) {
    for (const id of agg.repOrder) {
      if (seen.has(id)) continue;
      seen.add(id);
      repIds.push(id);
    }
    for (const id of agg.repTotals.keys()) {
      if (seen.has(id)) continue;
      seen.add(id);
      repIds.push(id);
    }
  }

  const rows: CrossRepRow[] = repIds.map((repId) => {
    const family = repFamily(repId);
    const chartFair = usesChartFairScoring(family);
    const byModel: ModelRepScore[] = aggregates.map((agg) => {
      const hit = agg.repTotals.get(repId);
      const done = hit?.done ?? 0;
      const correct = hit?.correct ?? 0;
      return {
        model: agg.model,
        runId: agg.runId,
        seed: agg.seed,
        correct,
        done,
        accuracy: done ? correct / done : null,
        seeds: agg.seeds,
      };
    });
    const accs = byModel
      .map((m) => m.accuracy)
      .filter((a): a is number => a != null);
    return {
      repId,
      label: repLabel(repId),
      family,
      byModel,
      meanAccuracy: mean(accs),
      modelsTested: accs.length,
      chartFair,
    };
  });

  const families: FamilyScore[] = FAMILY_ORDER
    .map((family) => {
      const familyRows = rows.filter((r) => r.family === family);
      const accs = familyRows
        .map((r) => r.meanAccuracy)
        .filter((a): a is number => a != null);
      return {
        family,
        label: FAMILY_LABELS[family],
        meanAccuracy: mean(accs),
        modelsTested: familyRows.reduce((n, r) => Math.max(n, r.modelsTested), 0),
        chartFair: usesChartFairScoring(family),
      };
    })
    .filter((f) => f.meanAccuracy != null || f.modelsTested > 0);

  const scoredRows = rows
    .filter((r) => r.meanAccuracy != null && r.modelsTested >= 1)
    .slice()
    .sort((a, b) => (b.meanAccuracy ?? 0) - (a.meanAccuracy ?? 0));
  const winningRep = scoredRows[0] ?? null;

  const scoredFamilies = families
    .filter((f) => f.meanAccuracy != null)
    .slice()
    .sort((a, b) => (b.meanAccuracy ?? 0) - (a.meanAccuracy ?? 0));
  const winningFamily = scoredFamilies[0] ?? null;

  const seedCount = seeds.length > 0 ? seeds.length : (picked.length > 0 ? 1 : 0);
  const summary = composeSummary({
    models,
    winningRep,
    winningFamily,
    families,
    seedCount,
    seeds,
  });

  return {
    models,
    rows,
    families,
    winningRep,
    winningFamily,
    seedCount,
    seeds,
    summary,
  };
}

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

function shortModel(model: string): string {
  return model.includes('/') ? model.split('/')[1]! : model;
}

function composeSummary(input: {
  models: CrossModelConclusion['models'];
  winningRep: CrossRepRow | null;
  winningFamily: FamilyScore | null;
  families: FamilyScore[];
  seedCount: number;
  seeds: number[];
}): string {
  const { models, winningRep, winningFamily, families, seedCount } = input;
  if (!models.length) {
    return 'No published runs yet — cross-model conclusions appear after the first probe matrix is saved.';
  }

  const modelBits = models
    .map((m) => {
      const seedNote = m.seeds > 1 ? `×${m.seeds} seeds` : '';
      return `${shortModel(m.model)} ${pct(m.overallAccuracy)}${seedNote ? ` (${seedNote})` : ''}`;
    })
    .join(', ');

  const parts: string[] = [
    `Across ${models.length} model${models.length === 1 ? '' : 's'}`
      + `${seedCount > 1 ? ` and ${seedCount} panel seeds` : ''}`
      + ` (${modelBits}):`,
  ];

  if (winningFamily?.meanAccuracy != null) {
    parts.push(
      `the winning method family is ${winningFamily.label.toLowerCase()} `
        + `(mean ${pct(winningFamily.meanAccuracy)} across encodings).`,
    );
  }

  if (winningRep?.meanAccuracy != null) {
    parts.push(
      `Best single representation: ${winningRep.label} at mean ${pct(winningRep.meanAccuracy)}.`,
    );
  }

  const pre = families.find((f) => f.family === 'precomputed_text');
  const raw = families.find((f) => f.family === 'raw_text');
  const image = families.find((f) => f.family === 'labeled_image');
  const hybrid = families.find((f) => f.family === 'hybrid');

  if (pre?.meanAccuracy != null && raw?.meanAccuracy != null) {
    if (pre.meanAccuracy > raw.meanAccuracy + 0.05) {
      parts.push(
        'Precomputed text packs beat raw closes CSV — the win is summarized stats, not text-as-modality alone.',
      );
    } else if (raw.meanAccuracy > pre.meanAccuracy + 0.05) {
      parts.push('Raw closes CSV beats precomputed packs on this panel.');
    }
  }

  if (raw?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (raw.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push('Raw CSV still beats labeled chart images on chart-fair questions.');
    } else if (image.meanAccuracy > raw.meanAccuracy + 0.05) {
      parts.push('Labeled chart images beat raw CSV on chart-fair questions.');
    } else {
      parts.push('Raw CSV and labeled images are close on chart-fair questions.');
    }
  } else if (pre?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (pre.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push('Precomputed text packs beat labeled chart images on this panel.');
    } else if (image.meanAccuracy > pre.meanAccuracy + 0.05) {
      parts.push('Labeled chart images beat precomputed text packs on this panel.');
    }
  }

  if (hybrid?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (hybrid.meanAccuracy + 0.05 < image.meanAccuracy) {
      parts.push('Textless charts + markdown color keys underperform labeled images — OCR was not the bottleneck.');
    } else if (hybrid.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push('Textless + color-key hybrids beat labeled images — offloading identity to markdown helps.');
    }
  }

  if (image?.chartFair || hybrid?.chartFair) {
    parts.push('Peak-date prompts are excluded from chart/hybrid family scores (pixel-hostile).');
  }

  return parts.join(' ');
}
