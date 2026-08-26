/**
 * Cross-model results for the text-vs-image experiment.
 * Aggregates per-representation accuracy across published runs so visitors
 * can see which encoding wins without opening each model separately.
 */

import { REPRESENTATION_LABELS, type RepresentationId } from './experiment.ts';

export type RepFamily = 'text' | 'labeled_image' | 'hybrid';

export interface RunRepAccuracy {
  rep_id: string;
  correct: number;
  done: number;
}

export interface RunSummaryForConclusion {
  id: string;
  model: string;
  created_at: number;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  rep_accuracy: RunRepAccuracy[];
  rep_order?: string[];
}

export interface ModelRepScore {
  model: string;
  runId: string;
  correct: number;
  done: number;
  accuracy: number | null;
}

export interface CrossRepRow {
  repId: string;
  label: string;
  family: RepFamily;
  byModel: ModelRepScore[];
  /** Mean accuracy across models that tested this rep (null if none). */
  meanAccuracy: number | null;
  modelsTested: number;
}

export interface FamilyScore {
  family: RepFamily;
  label: string;
  meanAccuracy: number | null;
  modelsTested: number;
}

export interface CrossModelConclusion {
  models: Array<{
    model: string;
    runId: string;
    created_at: number;
    cells_correct: number;
    cells_done: number;
    cells_total: number;
    overallAccuracy: number | null;
  }>;
  rows: CrossRepRow[];
  families: FamilyScore[];
  winningRep: CrossRepRow | null;
  winningFamily: FamilyScore | null;
  /** Short scoreboard takeaway for the cross-model results section. */
  summary: string;
  /** Closing narrative for the page-level Conclusion section. */
  wrapUp: string;
}

const FAMILY_LABELS: Record<RepFamily, string> = {
  text: 'Text packs',
  labeled_image: 'Labeled chart images',
  hybrid: 'Textless chart + color key',
};

export function repFamily(repId: string): RepFamily {
  if (repId.endsWith('_color_keyed') || repId.includes('textless')) return 'hybrid';
  if (
    repId === 'tool_summary'
    || repId === 'stats_table'
    || repId === 'csv_closes'
  ) {
    return 'text';
  }
  return 'labeled_image';
}

export function repLabel(repId: string): string {
  if (repId in REPRESENTATION_LABELS) {
    return REPRESENTATION_LABELS[repId as RepresentationId];
  }
  return repId.replace(/_/g, ' ');
}

/** Newest complete-enough run per model (dedupes repeated publishes). */
export function pickLatestRunPerModel(
  runs: RunSummaryForConclusion[],
): RunSummaryForConclusion[] {
  const byModel = new Map<string, RunSummaryForConclusion>();
  const sorted = runs.slice().sort((a, b) => b.created_at - a.created_at);
  for (const run of sorted) {
    if (byModel.has(run.model)) continue;
    // Prefer runs that finished most cells; skip empty shells.
    if (run.cells_done <= 0) continue;
    byModel.set(run.model, run);
  }
  return [...byModel.values()].sort((a, b) => b.created_at - a.created_at);
}

function mean(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function buildCrossModelConclusion(
  runs: RunSummaryForConclusion[],
): CrossModelConclusion {
  const picked = pickLatestRunPerModel(runs);
  const models = picked.map((r) => ({
    model: r.model,
    runId: r.id,
    created_at: r.created_at,
    cells_correct: r.cells_correct,
    cells_done: r.cells_done,
    cells_total: r.cells_total,
    overallAccuracy: r.cells_done ? r.cells_correct / r.cells_done : null,
  }));

  const repIds: string[] = [];
  const seen = new Set<string>();
  for (const run of picked) {
    const order = run.rep_order?.length
      ? run.rep_order
      : run.rep_accuracy.map((r) => r.rep_id);
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      repIds.push(id);
    }
  }

  const rows: CrossRepRow[] = repIds.map((repId) => {
    const byModel: ModelRepScore[] = picked.map((run) => {
      const hit = run.rep_accuracy.find((r) => r.rep_id === repId);
      const done = hit?.done ?? 0;
      const correct = hit?.correct ?? 0;
      return {
        model: run.model,
        runId: run.id,
        correct,
        done,
        accuracy: done ? correct / done : null,
      };
    });
    const accs = byModel
      .map((m) => m.accuracy)
      .filter((a): a is number => a != null);
    return {
      repId,
      label: repLabel(repId),
      family: repFamily(repId),
      byModel,
      meanAccuracy: mean(accs),
      modelsTested: accs.length,
    };
  });

  const families: FamilyScore[] = (['text', 'labeled_image', 'hybrid'] as RepFamily[])
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

  const summary = composeSummary({
    models,
    winningRep,
    winningFamily,
    families,
  });
  const wrapUp = composeWrapUp({
    models,
    winningRep,
    winningFamily,
    families,
  });

  return { models, rows, families, winningRep, winningFamily, summary, wrapUp };
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
}): string {
  const { models, winningRep, winningFamily, families } = input;
  if (!models.length) {
    return 'No published runs yet — cross-model results appear after the first probe matrix is saved.';
  }

  const modelBits = models
    .map((m) => `${shortModel(m.model)} ${pct(m.overallAccuracy)}`)
    .join(', ');

  const parts: string[] = [
    `Across ${models.length} model${models.length === 1 ? '' : 's'} (${modelBits}):`,
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

  const text = families.find((f) => f.family === 'text');
  const image = families.find((f) => f.family === 'labeled_image');
  const hybrid = families.find((f) => f.family === 'hybrid');
  if (text?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (text.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push('Text packs beat labeled chart images on this panel.');
    } else if (image.meanAccuracy > text.meanAccuracy + 0.05) {
      parts.push('Labeled chart images beat text packs on this panel.');
    } else {
      parts.push('Text packs and labeled images are close overall.');
    }
  }
  if (hybrid?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (hybrid.meanAccuracy + 0.05 < image.meanAccuracy) {
      parts.push('Textless charts + markdown color keys underperform labeled images — OCR was not the bottleneck.');
    } else if (hybrid.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push('Textless + color-key hybrids beat labeled images — offloading identity to markdown helps.');
    }
  }

  return parts.join(' ');
}

function composeWrapUp(input: {
  models: CrossModelConclusion['models'];
  winningRep: CrossRepRow | null;
  winningFamily: FamilyScore | null;
  families: FamilyScore[];
}): string {
  const { models, winningRep, winningFamily, families } = input;
  if (!models.length) {
    return 'Once published runs land, this closing note will pull the cross-model scoreboard '
      + 'into a single takeaway for Copilot framing — whether structured text, labeled charts, '
      + 'or textless charts with a markdown color key best survive LLM context on this panel.';
  }

  const text = families.find((f) => f.family === 'text');
  const image = families.find((f) => f.family === 'labeled_image');
  const hybrid = families.find((f) => f.family === 'hybrid');

  const parts: string[] = [
    'This notebook asked a production question: when Copilot reasons over a multi-name '
      + 'equity panel, which context encoding should we ship — structured text packs, labeled '
      + 'chart images, or textless charts paired with a markdown color key?',
  ];

  if (winningFamily?.meanAccuracy != null && winningRep?.meanAccuracy != null) {
    parts.push(
      `Across ${models.length} published model${models.length === 1 ? '' : 's'}, `
        + `the winning method family is ${winningFamily.label.toLowerCase()} `
        + `(mean ${pct(winningFamily.meanAccuracy)}), with `
        + `${winningRep.label} as the strongest single encoding `
        + `(mean ${pct(winningRep.meanAccuracy)}).`,
    );
  } else if (winningFamily?.meanAccuracy != null) {
    parts.push(
      `Across ${models.length} published model${models.length === 1 ? '' : 's'}, `
        + `the winning method family is ${winningFamily.label.toLowerCase()} `
        + `at mean ${pct(winningFamily.meanAccuracy)}.`,
    );
  }

  if (text?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (text.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push(
        'Text packs clearly outperform labeled images here, so keeping Copilot\'s '
          + 'period-stats and tool-summary framing is the safer default until chart encodings catch up.',
      );
    } else if (image.meanAccuracy > text.meanAccuracy + 0.05) {
      parts.push(
        'Labeled chart images beat text packs on this panel — multimodal chart context is '
          + 'worth investing in for production framing.',
      );
    } else {
      parts.push(
        'Text packs and labeled images land in a similar band, so encoding choice can follow '
          + 'latency and token budget rather than raw accuracy alone.',
      );
    }
  }

  if (hybrid?.meanAccuracy != null && image?.meanAccuracy != null) {
    if (hybrid.meanAccuracy > image.meanAccuracy + 0.05) {
      parts.push(
        'Hybrids that offload ticker identity to markdown beat labeled images, which suggests '
          + 'OCR — not visual structure — is the bottleneck, and production can keep charts '
          + 'visual-only while sending color legends in text.',
      );
    } else if (hybrid.meanAccuracy + 0.05 < image.meanAccuracy) {
      parts.push(
        'Textless + color-key hybrids did not beat labeled images, so OCR was not the main '
          + 'failure mode — labeled chart design still matters.',
      );
    }
  }

  parts.push(
    'The sections above keep the methodology inspectable: synthetic panel seed, exact chart '
      + 'PNGs, representation payloads, and graded prompts, so the next publish can re-check '
      + 'the same ground truth.',
  );

  return parts.join(' ');
}
