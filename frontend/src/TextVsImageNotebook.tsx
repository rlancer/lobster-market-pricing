import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ExperimentRunPayload, type ExperimentRunSummary } from './api';
import {
  buildCrossModelConclusion,
  type CrossModelConclusion,
  type RunSummaryForConclusion,
} from './notebooks/crossModelConclusion';
import {
  CONTEXT_ESTIMATOR_ID,
  formatContextTokens,
  imageFootprint,
  multimodalFootprint,
  textFootprint,
  type ContextFootprint,
} from './notebooks/contextFootprint';
import { EXPERIMENT_DESIGN_ID } from './notebooks/experiment';
import {
  buildHybridRepresentations,
  isHybridRepId,
  type HybridRep,
} from './notebooks/hybridRepresentations';
import {
  buildImageRepresentations,
  type ImageRep,
} from './notebooks/imageRepresentations';
import {
  buildQuestions,
  type ExperimentQuestion,
} from './notebooks/questions';
import {
  buildSynthUniverse,
  universeStats,
} from './notebooks/syntheticSeries';
import { buildTextAsImageRepresentations } from './notebooks/textAsImageRepresentations';
import {
  buildTextRepresentations,
  type TextRep,
} from './notebooks/textRepresentations';
import { textVsImageSnapshot } from './notebooks/textVsImageSnapshot';
import './Notebooks.css';

type TocEntry = { id: string; num: string; label: string };

const TOC_BEFORE: Array<{ id: string; label: string }> = [
  { id: 'overview', label: 'Overview' },
];

/** After per-model results: cross-model scoreboard, methodology, then wrap-up. */
const TOC_AFTER: Array<{ id: string; label: string }> = [
  { id: 'cross-model-results', label: 'Cross model results' },
  { id: 'reading', label: 'How to read' },
  { id: 'setup', label: 'Setup' },
  { id: 'footprint', label: 'Context space' },
  { id: 'images', label: 'Images' },
  { id: 'reps', label: 'Representations' },
  { id: 'questions', label: 'Questions' },
  { id: 'conclusion', label: 'Conclusion' },
];

function modelSectionId(runId: string): string {
  return `model-${runId}`;
}

function padNum(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function buildToc(modelRuns: ExperimentRunPayload[]): TocEntry[] {
  const modelEntries = modelRuns.map((run) => ({
    id: modelSectionId(run.id),
    label: shortModel(run.model),
  }));
  return [...TOC_BEFORE, ...modelEntries, ...TOC_AFTER].map((entry, index) => ({
    ...entry,
    num: padNum(index),
  }));
}

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
    <section id={id} className="notebook-section">
      <Heading level={2}>
        <span className="notebook-sec-num">{num}</span>
        {title}
      </Heading>
      {children}
    </section>
  );
}

type CellStatus = 'idle' | 'running' | 'done' | 'error';

interface ProbeCell {
  status: CellStatus;
  answer?: string;
  correct?: boolean;
  detail?: string;
  latencyMs?: number;
  error?: string;
  model?: string;
}

type Matrix = Record<string, Record<string, ProbeCell>>;

function emptyMatrix(repIds: string[], questionIds: string[]): Matrix {
  const out: Matrix = {};
  for (const repId of repIds) {
    out[repId] = {};
    for (const qId of questionIds) out[repId]![qId] = { status: 'idle' };
  }
  return out;
}

function matrixFromRun(run: ExperimentRunPayload): Matrix {
  const matrix = emptyMatrix(
    run.results.rep_order,
    run.results.questions.map((q) => q.id),
  );
  for (const cell of run.results.cells) {
    if (!matrix[cell.rep_id]) matrix[cell.rep_id] = {};
    matrix[cell.rep_id]![cell.question_id] = {
      status: cell.status,
      answer: cell.answer,
      correct: cell.correct,
      detail: cell.detail,
      latencyMs: cell.latency_ms,
      error: cell.error,
      model: cell.model,
    };
  }
  return matrix;
}

function imagesFromRun(run: ExperimentRunPayload): ImageRep[] {
  return run.images.map((img) => ({
    id: img.id as ImageRep['id'],
    label: img.label,
    description: img.description,
    width: img.width,
    height: img.height,
    dataUrl: img.data_url,
  }));
}

function shortModel(model: string): string {
  return model.includes('/') ? model.split('/')[1]! : model;
}

function formatRunWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function runAccuracyLabel(row: Pick<ExperimentRunSummary, 'cells_correct' | 'cells_done'>): string {
  return row.cells_done ? `${row.cells_correct}/${row.cells_done}` : '—';
}

function buildSnapshotConclusion(
  runList: ExperimentRunSummary[],
  modelRuns: ExperimentRunPayload[],
): CrossModelConclusion | null {
  if (!modelRuns.length) return null;
  const enriched: RunSummaryForConclusion[] = modelRuns.map((run) => {
    const summary = runList.find((row) => row.id === run.id);
    const byRep = new Map<string, { correct: number; done: number }>();
    for (const cell of run.results.cells) {
      if (cell.status !== 'done') continue;
      const current = byRep.get(cell.rep_id) ?? { correct: 0, done: 0 };
      current.done += 1;
      if (cell.correct) current.correct += 1;
      byRep.set(cell.rep_id, current);
    }
    const repOrder = run.results.rep_order.length
      ? run.results.rep_order
      : [...byRep.keys()];
    return {
      id: run.id,
      model: run.model,
      seed: run.seed,
      design_id: run.results.design_id,
      manifest_fingerprint: run.results.manifest.design_fingerprint_sha256,
      matrix_complete: summary?.matrix_complete ?? false,
      created_at: run.created_at,
      cells_correct: summary?.cells_correct
        ?? run.results.cells.filter((cell) => cell.status === 'done' && cell.correct).length,
      cells_done: summary?.cells_done
        ?? run.results.cells.filter((cell) => cell.status === 'done').length,
      cells_total: summary?.cells_total ?? run.results.cells.length,
      rep_order: repOrder,
      rep_accuracy: repOrder.map((repId) => {
        const stats = byRep.get(repId) ?? { correct: 0, done: 0 };
        return { rep_id: repId, correct: stats.correct, done: stats.done };
      }),
    };
  });
  return buildCrossModelConclusion(enriched);
}

const STATIC_SNAPSHOT_MATCHES_DESIGN =
  textVsImageSnapshot.design_id === EXPERIMENT_DESIGN_ID;
const STATIC_RUN_LIST = STATIC_SNAPSHOT_MATCHES_DESIGN
  ? textVsImageSnapshot.items
  : [];
const STATIC_MODEL_RUNS = STATIC_SNAPSHOT_MATCHES_DESIGN
  ? textVsImageSnapshot.model_runs
  : [];
const STATIC_CROSS_CUT = buildSnapshotConclusion(
  STATIC_RUN_LIST,
  STATIC_MODEL_RUNS,
);

function repLabelFromRun(run: ExperimentRunPayload, repId: string): string {
  const text = run.results.text_reps?.find((r) => r.id === repId);
  if (text) return text.label;
  const image = run.images.find((img) => img.id === repId);
  if (image) return image.label;
  return repId;
}

/** Prefer published footprints; otherwise derive from stored text/image payloads. */
function footprintsFromRun(run: ExperimentRunPayload): Map<string, ContextFootprint> {
  const map = new Map<string, ContextFootprint>();
  for (const fp of run.results.rep_footprints ?? []) {
    map.set(fp.rep_id, {
      ...fp,
      estimator: (fp.estimator as typeof CONTEXT_ESTIMATOR_ID | undefined) ?? CONTEXT_ESTIMATOR_ID,
    });
  }
  if (map.size) return map;

  const textById = new Map((run.results.text_reps ?? []).map((r) => [r.id, r]));
  const imageById = new Map(run.images.map((img) => [img.id, img]));
  const order = run.results.rep_order.length
    ? run.results.rep_order
    : [...new Set([
      ...(run.results.text_reps ?? []).map((r) => r.id),
      ...run.images.map((img) => img.id),
    ])];

  for (const repId of order) {
    if (map.has(repId)) continue;
    const text = textById.get(repId);
    const image = imageById.get(repId);
    if (text && image) {
      map.set(repId, multimodalFootprint(repId, text.body, image.width, image.height));
    } else if (image) {
      map.set(repId, imageFootprint(repId, image.width, image.height));
    } else if (text) {
      map.set(repId, textFootprint(repId, text.body));
    }
  }
  return map;
}

function ModelResultsTable({ run }: { run: ExperimentRunPayload }) {
  const matrix = useMemo(() => matrixFromRun(run), [run]);
  const footprints = useMemo(() => footprintsFromRun(run), [run]);
  const questions = run.results.questions;
  const repIds = run.results.rep_order.length
    ? run.results.rep_order
    : [...new Set(run.results.cells.map((c) => c.rep_id))];

  const summaryRows = repIds.map((repId) => {
    const cells = questions.map((q) => matrix[repId]?.[q.id] ?? { status: 'idle' as const });
    const doneCells = cells.filter((c) => c.status === 'done');
    const correct = doneCells.filter((c) => c.correct).length;
    const done = doneCells.length;
    const fp = footprints.get(repId);
    return {
      repId,
      label: repLabelFromRun(run, repId),
      done,
      correct,
      acc: done ? correct / done : null,
      contextTokens: fp?.total_tokens ?? null,
      contextDetail: fp
        ? fp.mode === 'text'
          ? 'text'
          : fp.mode === 'image'
            ? `vision (${fp.image_tiles ?? '?'} tiles)`
            : 'text+vision'
        : null,
    };
  });

  return (
    <div className="notebook-results">
      <table>
        <thead>
          <tr>
            <th>Representation</th>
            <th className="num">Context</th>
            <th>Correct</th>
            <th>Accuracy</th>
            {questions.map((q) => (
              <th key={q.id}>{q.id}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summaryRows.map((row) => (
            <tr key={row.repId}>
              <td>{row.label}</td>
              <td className="num" title={row.contextDetail ?? undefined}>
                {row.contextTokens == null ? '—' : formatContextTokens(row.contextTokens)}
              </td>
              <td className="num">{row.done ? `${row.correct}/${row.done}` : '—'}</td>
              <td className="num">
                {row.acc == null ? '—' : `${(row.acc * 100).toFixed(0)}%`}
              </td>
              {questions.map((q) => {
                const cell = matrix[row.repId]?.[q.id];
                if (!cell || cell.status === 'idle') return <td key={q.id}>·</td>;
                if (cell.status === 'running') return <td key={q.id}>…</td>;
                if (cell.status === 'error') {
                  return (
                    <td key={q.id}>
                      <Token label="err" color="red" size="sm" />
                    </td>
                  );
                }
                return (
                  <td key={q.id}>
                    <VStack gap={1}>
                      <Token
                        label={cell.correct ? 'ok' : 'miss'}
                        color={cell.correct ? 'teal' : 'orange'}
                        size="sm"
                      />
                      <span className="notebook-answer">{cell.answer}</span>
                    </VStack>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Public, read-only experiment: saved runs only (probe/publish via API / CI / agents). */
export default function TextVsImageNotebookPage() {
  const [localImages, setLocalImages] = useState<ImageRep[]>([]);
  const [localHybrids, setLocalHybrids] = useState<HybridRep[]>([]);
  const [selectedRep, setSelectedRep] = useState('tool_summary');
  const [activeSection, setActiveSection] = useState('overview');
  const [expandedModels, setExpandedModels] = useState<Set<string>>(() => new Set());
  const runList = STATIC_RUN_LIST;
  const modelRuns = STATIC_MODEL_RUNS;
  const referenceRun = modelRuns[0] ?? null;
  const crossCut = STATIC_CROSS_CUT;

  const toc = useMemo(() => buildToc(modelRuns), [modelRuns]);
  const tocById = useMemo(() => {
    const map = new Map<string, TocEntry>();
    for (const entry of toc) map.set(entry.id, entry);
    return map;
  }, [toc]);

  const expandModel = (runId: string) => {
    setExpandedModels((prev) => {
      if (prev.has(runId)) return prev;
      const next = new Set(prev);
      next.add(runId);
      return next;
    });
  };

  const toggleModel = (runId: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const universe = useMemo(() => buildSynthUniverse(), []);
  const stats = useMemo(() => universeStats(universe), [universe]);
  const textReps = useMemo(() => buildTextRepresentations(universe), [universe]);
  const questions = useMemo(() => buildQuestions(universe), [universe]);

  useEffect(() => {
    try {
      setLocalImages([
        ...buildImageRepresentations(universe),
        ...buildTextAsImageRepresentations(universe),
      ]);
      setLocalHybrids(buildHybridRepresentations(universe));
    } catch (error) {
      console.error(error);
      setLocalImages([]);
      setLocalHybrids([]);
    }
  }, [universe]);

  useEffect(() => {
    const syncHash = () => {
      const id = window.location.hash.replace(/^#/, '');
      if (id.startsWith('model-')) expandModel(id.slice('model-'.length));
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  useEffect(() => {
    const nodes = toc
      .map((section) => document.getElementById(section.id))
      .filter((node): node is HTMLElement => Boolean(node));
    if (!nodes.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target.id;
        if (top) setActiveSection(top);
      },
      {
        root: null,
        rootMargin: '0px 0px -65% 0px',
        threshold: [0.1, 0.25, 0.5],
      },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [toc]);

  const savedImages = useMemo(
    () => (referenceRun?.images?.length ? imagesFromRun(referenceRun) : []),
    [referenceRun],
  );
  const savedHybrids: HybridRep[] = useMemo(() => {
    if (!referenceRun) return [];
    const textById = new Map(
      (referenceRun.results.text_reps ?? []).map((r) => [r.id, r]),
    );
    return referenceRun.images
      .filter((img) => isHybridRepId(img.id) && textById.has(img.id))
      .map((img) => {
        const text = textById.get(img.id)!;
        return {
          id: img.id as HybridRep['id'],
          label: img.label,
          description: img.description,
          width: img.width,
          height: img.height,
          dataUrl: img.data_url,
          textContext: text.body,
          approxTokens: text.approx_tokens ?? Math.ceil(text.body.length / 4),
        };
      });
  }, [referenceRun]);

  const hasSavedPayload = Boolean(referenceRun);
  const displayHybrids = hasSavedPayload && savedHybrids.length
    ? savedHybrids
    : localHybrids;

  const displayImages = useMemo(() => {
    const base = hasSavedPayload && savedImages.length ? savedImages : localImages;
    const hybridImgs: ImageRep[] = displayHybrids.map((h) => ({
      id: h.id as ImageRep['id'],
      label: h.label,
      description: h.description,
      width: h.width,
      height: h.height,
      dataUrl: h.dataUrl,
    }));
    const classic = base.filter((img) => !isHybridRepId(img.id));
    return [...classic, ...hybridImgs];
  }, [hasSavedPayload, savedImages, localImages, displayHybrids]);

  const displayTextReps: TextRep[] = useMemo(() => {
    if (hasSavedPayload && referenceRun?.results.text_reps?.length) {
      return referenceRun.results.text_reps
        .filter((r) => !isHybridRepId(r.id))
        .map((r) => ({
          id: r.id as TextRep['id'],
          label: r.label,
          description: r.description,
          approxTokens: r.approx_tokens ?? Math.ceil(r.body.length / 4),
          body: r.body,
        }));
    }
    return textReps;
  }, [hasSavedPayload, referenceRun, textReps]);

  const displayQuestions: ExperimentQuestion[] = useMemo(() => {
    if (hasSavedPayload && referenceRun?.results.questions?.length) {
      const byId = new Map(questions.map((q) => [q.id, q]));
      return referenceRun.results.questions.map((q) => {
        const local = byId.get(q.id);
        return local
          ? { ...local, prompt: q.prompt, expected: q.expected }
          : {
              id: q.id,
              prompt: q.prompt,
              kind: 'ticker' as const,
              expected: q.expected,
              notes: '',
            };
      });
    }
    return questions;
  }, [hasSavedPayload, referenceRun, questions]);

  const allReps: Array<TextRep | ImageRep | HybridRep> = useMemo(
    () => [...displayTextReps, ...displayImages.filter((img) => !isHybridRepId(img.id)), ...displayHybrids],
    [displayTextReps, displayImages, displayHybrids],
  );

  const localFootprints = useMemo(() => {
    const list: ContextFootprint[] = [
      ...textReps.map((r) => textFootprint(r.id, r.body)),
      ...localImages.filter((img) => !isHybridRepId(img.id)).map((img) => (
        imageFootprint(img.id, img.width, img.height)
      )),
      ...localHybrids.map((h) => multimodalFootprint(h.id, h.textContext, h.width, h.height)),
    ];
    return list;
  }, [textReps, localImages, localHybrids]);

  const displayFootprints = useMemo(() => {
    if (hasSavedPayload && referenceRun) {
      const fromRun = footprintsFromRun(referenceRun);
      if (fromRun.size) return [...fromRun.values()];
    }
    return localFootprints;
  }, [hasSavedPayload, referenceRun, localFootprints]);

  const selectedText = displayTextReps.find((r) => r.id === selectedRep) ?? null;
  const selectedHybrid = displayHybrids.find((r) => r.id === selectedRep) ?? null;
  const selectedImage = selectedHybrid
    ? null
    : (displayImages.find((r) => r.id === selectedRep) ?? null);

  const crossResultsNum = tocById.get('cross-model-results')?.num ?? '03';
  const readingNum = tocById.get('reading')?.num ?? '04';
  const setupNum = tocById.get('setup')?.num ?? '05';
  const footprintNum = tocById.get('footprint')?.num ?? '06';
  const imagesNum = tocById.get('images')?.num ?? '07';
  const repsNum = tocById.get('reps')?.num ?? '08';
  const questionsNum = tocById.get('questions')?.num ?? '09';
  const conclusionNum = tocById.get('conclusion')?.num ?? '10';

  return (
    <div className="notebook-layout">
      <div className="notebook-body">
        <section id="overview" className="notebook-section">
          <VStack className="notebook-hero" gap={2}>
            <Text type="supporting">
              <Link to="/experiments">Experiments</Link>
              {' / '}
              Text vs image
            </Text>
            <Heading level={1}>Text vs image context for market panels</Heading>
            <Text type="supporting">
              The same deterministic dense synthetic equity panel (80 names × ~1 trading year)
              is shown to a multimodal model as AI-style text, as those exact text packs
              rasterized to PNG (modality control), as labeled chart images, or as textless
              charts with a markdown color key. This is a task-aligned encoding benchmark:
              charts and text packs expose different information, while <code>*_as_image</code>
              twins isolate tokens vs pixels. Scores describe end-to-end usefulness on these
              prompts rather than a causal text-versus-image effect.
            </Text>
          </VStack>

          {!modelRuns.length ? (
            <Text type="supporting">
              No generated results snapshot is available yet. Methodology and local chart
              previews remain available.
            </Text>
          ) : null}
          {modelRuns.length ? (
            <Text type="supporting">
              {modelRuns.length} model{modelRuns.length === 1 ? '' : 's'} published in the
              {' '}static snapshot generated {formatRunWhen(Date.parse(textVsImageSnapshot.generated_at))}
              {' — '}
              use the table of contents to jump; per-model matrices start collapsed.
            </Text>
          ) : null}
        </section>

        {modelRuns.map((run) => {
          const sectionId = modelSectionId(run.id);
          const entry = tocById.get(sectionId);
          const expanded = expandedModels.has(run.id);
          const summary = runList.find((row) => row.id === run.id);
          const meta = [
            formatRunWhen(run.created_at),
            summary ? runAccuracyLabel(summary) : null,
          ].filter(Boolean).join(' · ');
          return (
            <section key={run.id} id={sectionId} className="notebook-section notebook-model-section">
              <button
                type="button"
                className="notebook-model-toggle"
                aria-expanded={expanded}
                onClick={() => toggleModel(run.id)}
              >
                {expanded
                  ? <ChevronDown size={16} aria-hidden />
                  : <ChevronRight size={16} aria-hidden />}
                <span className="notebook-model-title">
                  <span className="notebook-sec-num">{entry?.num ?? '—'}</span>
                  {shortModel(run.model)}
                </span>
                <span className="notebook-model-meta">{meta}</span>
              </button>
              {expanded ? (
                <VStack gap={3}>
                  <Text type="supporting">
                    Per-representation scores for <code>{run.model}</code>
                    {' '}(seed <code>{run.seed}</code>, design{' '}
                    <code>{run.results.design_id}</code>, source{' '}
                    <code>{run.results.manifest.source_revision.slice(0, 12)}</code>).
                  </Text>
                  <ModelResultsTable run={run} />
                </VStack>
              ) : (
                <Text type="supporting">
                  Collapsed — expand here or jump from the table of contents.
                </Text>
              )}
            </section>
          );
        })}

        {!modelRuns.length ? (
          <section className="notebook-section">
            <Text type="supporting">
              Per-model result matrices appear here once runs are published via API or CI.
            </Text>
          </section>
        ) : null}

        <Section id="cross-model-results" num={crossResultsNum} title="Cross model results">
          {!crossCut ? (
            <Text type="supporting">
              Cross model results appear once a generated snapshot contains a complete run.
            </Text>
          ) : null}
          {crossCut ? (
            <>
              <Text type="supporting">{crossCut.summary}</Text>
              <HStack gap={2} style={{ flexWrap: 'wrap' }}>
                {crossCut.winningFamily ? (
                  <Token
                    label={`Highest observed family: ${crossCut.winningFamily.label} (${
                      crossCut.winningFamily.meanAccuracy == null
                        ? '—'
                        : `${Math.round(crossCut.winningFamily.meanAccuracy * 100)}%`
                    })`}
                    color="teal"
                    size="sm"
                  />
                ) : null}
                {crossCut.winningRep ? (
                  <Token
                    label={`Highest observed encoding: ${crossCut.winningRep.label} (${
                      crossCut.winningRep.meanAccuracy == null
                        ? '—'
                        : `${Math.round(crossCut.winningRep.meanAccuracy * 100)}%`
                    })`}
                    color="teal"
                    size="sm"
                  />
                ) : null}
              </HStack>
              <div className="notebook-results notebook-results-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Representation</th>
                      <th>Family</th>
                      <th className="num">Context</th>
                      <th className="num">Mean</th>
                      {crossCut.models.map((m) => (
                        <th key={m.runId} className="num">
                          <code>{shortModel(m.model)}</code>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {crossCut.rows.map((row) => {
                      const isWinner = crossCut.winningRep?.repId === row.repId;
                      const fp = displayFootprints.find((f) => f.rep_id === row.repId);
                      return (
                        <tr key={row.repId} className={isWinner ? 'notebook-row-winner' : undefined}>
                          <td>{row.label}</td>
                          <td>{row.family.replaceAll('_', ' ')}</td>
                          <td className="num">
                            {fp ? formatContextTokens(fp.total_tokens) : '—'}
                          </td>
                          <td className="num">
                            {row.meanAccuracy == null
                              ? '—'
                              : `${Math.round(row.meanAccuracy * 100)}%`}
                          </td>
                          {row.byModel.map((cell) => (
                            <td key={`${row.repId}-${cell.runId}`} className="num">
                              {cell.done
                                ? `${cell.correct}/${cell.done}`
                                : '—'}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    <tr>
                      <td><strong>Overall</strong></td>
                      <td />
                      <td />
                      <td className="num">
                        {(() => {
                          const accs = crossCut.models
                            .map((m) => m.overallAccuracy)
                            .filter((a): a is number => a != null);
                          if (!accs.length) return '—';
                          const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
                          return `${Math.round(mean * 100)}%`;
                        })()}
                      </td>
                      {crossCut.models.map((m) => (
                        <td key={`overall-${m.runId}`} className="num">
                          {m.cells_done
                            ? `${m.cells_correct}/${m.cells_done}`
                            : '—'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="notebook-results">
                <table>
                  <thead>
                    <tr>
                      <th>Method family</th>
                      <th className="num">Mean accuracy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {crossCut.families.map((f) => (
                      <tr
                        key={f.family}
                        className={
                          crossCut.winningFamily?.family === f.family
                            ? 'notebook-row-winner'
                            : undefined
                        }
                      >
                        <td>{f.label}</td>
                        <td className="num">
                          {f.meanAccuracy == null
                            ? '—'
                            : `${Math.round(f.meanAccuracy * 100)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </Section>

        <Section id="reading" num={readingNum} title="How to read this">
          <Text type="supporting">
            The decisive control is each text pack vs its <code>*_as_image</code> twin
            (identical content, tokens vs pixels). Compare accuracy against{' '}
            <strong>context space</strong> — how many estimated tokens each encoding burns
            in the model window. Charts and hybrids are not content-matched to text:
            geometry, labels, numeric detail, and instructions differ, so a hybrid
            advantage does not isolate OCR and family means are descriptive rather than a
            significance test. Also compare labeled charts and hybrid{' '}
            <code>*_color_keyed</code> rows (textless chart + markdown color key). Ranked bars
            directly support ranking prompts, while tables expose exact statistics; interpret
            each row as an end-to-end encoding result.
          </Text>
        </Section>

        <Section id="setup" num={setupNum} title="Setup">
          <Text type="supporting">
            Seed <code>{universe.seed}</code>, {universe.tradingDays} trading days from{' '}
            {universe.startDate}, {universe.series.length} fictional tickers (GBM with planted
            crashes/rallies). Density is intentional — wide cross-section plus year-long
            paths. Design <code>{EXPERIMENT_DESIGN_ID}</code> isolates these prompts,
            scorers, and representations from legacy runs. Only complete matrices are published;
            probe order is deterministically shuffled and transient failures are retried.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Sector</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Return %</th>
                  <th>Daily σ %</th>
                  <th>Peak date</th>
                  <th>Crash day</th>
                </tr>
              </thead>
              <tbody>
                {stats
                  .slice()
                  .sort((a, b) => b.totalReturnPct - a.totalReturnPct)
                  .map((s) => (
                    <tr key={s.ticker}>
                      <td>{s.ticker}</td>
                      <td>{s.sector}</td>
                      <td className="num">{s.startClose.toFixed(2)}</td>
                      <td className="num">{s.endClose.toFixed(2)}</td>
                      <td className="num">{s.totalReturnPct.toFixed(2)}</td>
                      <td className="num">{s.dailyReturnStdPct.toFixed(3)}</td>
                      <td className="num">{s.maxCloseDate}</td>
                      <td className="num">{s.crashDay ?? '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="footprint" num={footprintNum} title="Context space">
          <Text type="supporting">
            Estimated tokens each encoding occupies in the model context window.
            Text uses chars÷4. Images use the OpenAI GPT-4o / GPT-4.1 high-detail tile
            formula (fit 2048², short side ≤768, then 85 + 170×512² tiles). Hybrids sum
            both. Absolute bills vary by provider; these numbers are for comparing
            encodings on one scale.
          </Text>
          {!displayFootprints.length ? (
            <Text type="supporting">No footprint estimates yet.</Text>
          ) : (
            <div className="notebook-results">
              <table>
                <thead>
                  <tr>
                    <th>Representation</th>
                    <th>Mode</th>
                    <th className="num">Text tok</th>
                    <th className="num">Vision tok</th>
                    <th className="num">Total context</th>
                    <th className="num">Image</th>
                  </tr>
                </thead>
                <tbody>
                  {displayFootprints
                    .slice()
                    .sort((a, b) => b.total_tokens - a.total_tokens)
                    .map((fp) => {
                      const label = allReps.find((r) => r.id === fp.rep_id)?.label
                        ?? (referenceRun ? repLabelFromRun(referenceRun, fp.rep_id) : fp.rep_id);
                      return (
                        <tr key={fp.rep_id}>
                          <td>{label}</td>
                          <td>{fp.mode}</td>
                          <td className="num">{formatContextTokens(fp.text_tokens)}</td>
                          <td className="num">{formatContextTokens(fp.image_tokens)}</td>
                          <td className="num"><strong>{formatContextTokens(fp.total_tokens)}</strong></td>
                          <td className="num">
                            {fp.image_width && fp.image_height
                              ? `${fp.image_width}×${fp.image_height}`
                                + (fp.image_tiles != null ? ` · ${fp.image_tiles} tiles` : '')
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section id="images" num={imagesNum} title="Images fed to the LLM">
          <Text type="supporting">
            These are the exact PNGs used as multimodal user content
            {hasSavedPayload && savedImages.length
              ? ' in the saved runs (byte-identical to what OpenRouter received).'
              : ' when probes run (local canvas previews until a run is published).'}
            {' '}Includes labeled charts, text-as-image rasters of the text packs, and
            textless hybrids (ticker identity in the companion markdown key).
          </Text>
          {!displayImages.length ? (
            <Text type="supporting">No images available yet.</Text>
          ) : (
            <div className="notebook-image-gallery">
              {displayImages.map((img) => (
                <figure key={img.id} className="notebook-image-card">
                  <figcaption>
                    <strong>{img.label}</strong>
                    <span>{img.description}</span>
                    <code>{img.width}×{img.height} · {img.id}</code>
                  </figcaption>
                  <div className="notebook-figure">
                    <img src={img.dataUrl} alt={`${img.label} — exact image sent to the model`} />
                  </div>
                </figure>
              ))}
            </div>
          )}
        </Section>

        <Section id="reps" num={repsNum} title="Representations">
          <Text type="supporting">
            Text packs mirror today&apos;s AI tool summary. <code>*_as_image</code> rows
            are those same packs as monospace PNGs. Chart encodings are labeled plots.
            Hybrid rows send a textless PNG plus a markdown color key (no OCR). Pick one
            to inspect the payload.
          </Text>
          <HStack gap={2} style={{ flexWrap: 'wrap' }}>
            {allReps.map((rep) => (
              <Button
                key={rep.id}
                size="sm"
                variant={selectedRep === rep.id ? 'primary' : 'secondary'}
                label={'approxTokens' in rep
                  ? `${rep.label} (~${rep.approxTokens} tok)`
                  : rep.label}
                onClick={() => setSelectedRep(rep.id)}
              />
            ))}
          </HStack>
          {selectedText ? (
            <VStack gap={2}>
              <Text type="supporting">{selectedText.description}</Text>
              <pre className="notebook-code">
                {selectedText.body.slice(0, 6_000)}
                {selectedText.body.length > 6_000 ? '\n…' : ''}
              </pre>
            </VStack>
          ) : null}
          {selectedHybrid ? (
            <VStack gap={2}>
              <Text type="supporting">{selectedHybrid.description}</Text>
              <Text type="supporting">Markdown color key sent with the image:</Text>
              <pre className="notebook-code">
                {selectedHybrid.textContext.slice(0, 6_000)}
                {selectedHybrid.textContext.length > 6_000 ? '\n…' : ''}
              </pre>
              <div className="notebook-figure">
                <img src={selectedHybrid.dataUrl} alt={selectedHybrid.label} />
              </div>
            </VStack>
          ) : null}
          {selectedImage ? (
            <VStack gap={2}>
              <Text type="supporting">{selectedImage.description}</Text>
              <div className="notebook-figure">
                <img src={selectedImage.dataUrl} alt={selectedImage.label} />
              </div>
            </VStack>
          ) : null}
        </Section>

        <Section id="questions" num={questionsNum} title="Questions">
          <Text type="supporting">
            Each representation answers the same ground-truth prompts — basic ranking plus
            density-stress items (counts, median rank, sector means, mid-panel lookups).
            Answers must follow the requested exact format; scoring is deterministic and
            uses no judge model.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Prompt</th>
                  <th>Expected</th>
                </tr>
              </thead>
              <tbody>
                {displayQuestions.map((q) => (
                  <tr key={q.id}>
                    <td><code>{q.id}</code></td>
                    <td>{q.prompt}</td>
                    <td className="num">{q.expected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="conclusion" num={conclusionNum} title="Conclusion">
          {crossCut ? (
            <Text type="supporting">{crossCut.wrapUp}</Text>
          ) : (
            <Text type="supporting">
              A generated results snapshot will add the cross-model conclusion here.
            </Text>
          )}
        </Section>
      </div>

      <nav className="notebook-toc" aria-label="Experiment sections">
        <span className="notebook-toc-title">On this page</span>
        {toc.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={activeSection === section.id ? 'notebook-toc-link active' : 'notebook-toc-link'}
            aria-current={activeSection === section.id ? 'location' : undefined}
            onClick={() => {
              if (section.id.startsWith('model-')) {
                expandModel(section.id.slice('model-'.length));
              }
            }}
          >
            <span className="notebook-toc-num">{section.num}</span>
            <span>{section.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
