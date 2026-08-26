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
import { api, type ExperimentRunPayload, type ExperimentRunSummary } from './api';
import {
  buildCrossModelConclusion,
  type CrossModelConclusion,
  type RunSummaryForConclusion,
} from './notebooks/crossModelConclusion';
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
import {
  buildTextRepresentations,
  type TextRep,
} from './notebooks/textRepresentations';
import './Notebooks.css';

const EXPERIMENT_SLUG = 'text-vs-image';

type TocEntry = { id: string; num: string; label: string };

const TOC_BEFORE: Array<{ id: string; label: string }> = [
  { id: 'overview', label: 'Overview' },
];

/** After per-model results: takeaway, then methodology. */
const TOC_AFTER: Array<{ id: string; label: string }> = [
  { id: 'conclusion', label: 'Conclusion' },
  { id: 'reading', label: 'How to read' },
  { id: 'setup', label: 'Setup' },
  { id: 'images', label: 'Images' },
  { id: 'reps', label: 'Representations' },
  { id: 'questions', label: 'Questions' },
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

/** Newest-first list with one row per model (first win). */
function uniqueModelSummaries(runList: ExperimentRunSummary[]): ExperimentRunSummary[] {
  const seen = new Set<string>();
  const out: ExperimentRunSummary[] = [];
  for (const row of runList) {
    if (seen.has(row.model)) continue;
    seen.add(row.model);
    out.push(row);
  }
  return out;
}

function repLabelFromRun(run: ExperimentRunPayload, repId: string): string {
  const text = run.results.text_reps?.find((r) => r.id === repId);
  if (text) return text.label;
  const image = run.images.find((img) => img.id === repId);
  if (image) return image.label;
  return repId;
}

function ModelResultsTable({ run }: { run: ExperimentRunPayload }) {
  const matrix = useMemo(() => matrixFromRun(run), [run]);
  const questions = run.results.questions;
  const repIds = run.results.rep_order.length
    ? run.results.rep_order
    : [...new Set(run.results.cells.map((c) => c.rep_id))];

  const summaryRows = repIds.map((repId) => {
    const cells = questions.map((q) => matrix[repId]?.[q.id] ?? { status: 'idle' as const });
    const doneCells = cells.filter((c) => c.status === 'done');
    const correct = doneCells.filter((c) => c.correct).length;
    const done = doneCells.length;
    return {
      repId,
      label: repLabelFromRun(run, repId),
      done,
      correct,
      acc: done ? correct / done : null,
    };
  });

  return (
    <div className="notebook-results">
      <table>
        <thead>
          <tr>
            <th>Representation</th>
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
  const [runList, setRunList] = useState<ExperimentRunSummary[]>([]);
  const [modelRuns, setModelRuns] = useState<ExperimentRunPayload[]>([]);
  const [referenceRun, setReferenceRun] = useState<ExperimentRunPayload | null>(null);
  const [crossCut, setCrossCut] = useState<CrossModelConclusion | null>(null);
  const [crossCutState, setCrossCutState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [runLoadState, setRunLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [runLoadError, setRunLoadError] = useState<string | null>(null);
  const [selectedRep, setSelectedRep] = useState('tool_summary');
  const [activeSection, setActiveSection] = useState('overview');
  const [expandedModels, setExpandedModels] = useState<Set<string>>(() => new Set());

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
      setLocalImages(buildImageRepresentations(universe));
      setLocalHybrids(buildHybridRepresentations(universe));
    } catch (error) {
      console.error(error);
      setLocalImages([]);
      setLocalHybrids([]);
    }
  }, [universe]);

  useEffect(() => {
    let cancelled = false;
    setRunLoadState('loading');
    setRunLoadError(null);
    void (async () => {
      try {
        const listed = await api.experimentListRuns(EXPERIMENT_SLUG, 20);
        if (cancelled) return;
        setRunList(listed.items);
        const unique = uniqueModelSummaries(listed.items);
        if (!unique.length) {
          setModelRuns([]);
          setReferenceRun(null);
          setRunLoadState('missing');
          return;
        }
        const loaded: ExperimentRunPayload[] = [];
        for (let i = 0; i < unique.length; i += 1) {
          const row = unique[i]!;
          // First run keeps images for the methodology gallery; later runs skip blobs.
          // eslint-disable-next-line no-await-in-loop
          const full = await api.experimentRun(EXPERIMENT_SLUG, row.id, {
            images: i === 0,
          });
          loaded.push(full);
        }
        if (cancelled) return;
        setModelRuns(loaded);
        setReferenceRun(loaded[0] ?? null);
        setRunLoadState('ready');
      } catch (error: unknown) {
        if (cancelled) return;
        const message = String((error as Error)?.message ?? error);
        if (/404|no published run|run not found/i.test(message)) {
          setRunList([]);
          setModelRuns([]);
          setReferenceRun(null);
          setRunLoadState('missing');
        } else {
          setRunLoadState('error');
          setRunLoadError(message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!modelRuns.length) {
      setCrossCut(null);
      setCrossCutState(runLoadState === 'loading' ? 'loading' : 'idle');
      return;
    }

    const enriched: RunSummaryForConclusion[] = modelRuns.map((run) => {
      const summary = runList.find((row) => row.id === run.id);
      const byRep = new Map<string, { correct: number; done: number }>();
      for (const cell of run.results.cells) {
        if (cell.status !== 'done') continue;
        const cur = byRep.get(cell.rep_id) ?? { correct: 0, done: 0 };
        cur.done += 1;
        if (cell.correct) cur.correct += 1;
        byRep.set(cell.rep_id, cur);
      }
      const repOrder = run.results.rep_order.length
        ? run.results.rep_order
        : [...byRep.keys()];
      return {
        id: run.id,
        model: run.model,
        created_at: run.created_at,
        cells_correct: summary?.cells_correct
          ?? run.results.cells.filter((c) => c.status === 'done' && c.correct).length,
        cells_done: summary?.cells_done
          ?? run.results.cells.filter((c) => c.status === 'done').length,
        cells_total: summary?.cells_total
          ?? run.results.cells.length,
        rep_order: repOrder,
        rep_accuracy: repOrder.map((repId) => {
          const stats = byRep.get(repId) ?? { correct: 0, done: 0 };
          return { rep_id: repId, correct: stats.correct, done: stats.done };
        }),
      };
    });
    setCrossCut(buildCrossModelConclusion(enriched));
    setCrossCutState('ready');
  }, [modelRuns, runList, runLoadState]);

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

  const selectedText = displayTextReps.find((r) => r.id === selectedRep) ?? null;
  const selectedHybrid = displayHybrids.find((r) => r.id === selectedRep) ?? null;
  const selectedImage = selectedHybrid
    ? null
    : (displayImages.find((r) => r.id === selectedRep) ?? null);

  const conclusionNum = tocById.get('conclusion')?.num ?? '03';
  const readingNum = tocById.get('reading')?.num ?? '04';
  const setupNum = tocById.get('setup')?.num ?? '05';
  const imagesNum = tocById.get('images')?.num ?? '06';
  const repsNum = tocById.get('reps')?.num ?? '07';
  const questionsNum = tocById.get('questions')?.num ?? '08';

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
              The same deterministic 20-name synthetic equity panel is shown to a multimodal
              model either as Copilot-style text summaries, as chart images, or as textless
              charts paired with a markdown color key (so the model does not need OCR).
              Answers are scored against ground truth so we can see which encodings survive
              LLM context before changing production Copilot framing.
            </Text>
          </VStack>

          {runLoadState === 'loading' ? (
            <Text type="supporting">Loading saved runs…</Text>
          ) : null}
          {runLoadState === 'missing' ? (
            <Text type="supporting">
              No saved run yet. Methodology and local chart previews are free;
              results appear after a run is published via API or CI.
            </Text>
          ) : null}
          {runLoadState === 'error' ? (
            <Text type="supporting">Could not load saved runs: {runLoadError}</Text>
          ) : null}
          {runLoadState === 'ready' && modelRuns.length ? (
            <Text type="supporting">
              {modelRuns.length} model{modelRuns.length === 1 ? '' : 's'} published
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
                    {' '}(seed <code>{run.seed}</code>).
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

        {!modelRuns.length && runLoadState !== 'loading' ? (
          <section className="notebook-section">
            <Text type="supporting">
              Per-model result matrices appear here once runs are published via API or CI.
            </Text>
          </section>
        ) : null}

        <Section id="conclusion" num={conclusionNum} title="Cross-model conclusion">
          {crossCutState === 'loading' || (crossCutState === 'idle' && runList.length > 0) ? (
            <Text type="supporting">Aggregating saved runs…</Text>
          ) : null}
          {crossCutState === 'idle' && runList.length === 0 ? (
            <Text type="supporting">
              Cross-model conclusions appear once at least one run is published.
            </Text>
          ) : null}
          {crossCutState === 'error' ? (
            <Text type="supporting">Could not build the cross-model summary.</Text>
          ) : null}
          {crossCut && crossCutState === 'ready' ? (
            <>
              <Text type="supporting">{crossCut.summary}</Text>
              <HStack gap={2} style={{ flexWrap: 'wrap' }}>
                {crossCut.winningFamily ? (
                  <Token
                    label={`Winner family: ${crossCut.winningFamily.label} (${
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
                    label={`Best encoding: ${crossCut.winningRep.label} (${
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
                      return (
                        <tr key={row.repId} className={isWinner ? 'notebook-row-winner' : undefined}>
                          <td>{row.label}</td>
                          <td>{row.family.replace('_', ' ')}</td>
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
            Compare <code>tool_summary</code> (today&apos;s Copilot framing) against labeled
            image encodings and the hybrid <code>*_color_keyed</code> rows (textless chart +
            markdown color key). If hybrids beat labeled images on the same model, OCR was the
            bottleneck — production can send color legends in text and keep charts visual-only.
            Ranked bars and small multiples should dominate who-won / who-lost questions;
            heatmaps help regime/crash reads; crowded overlays often lose ticker identity.
          </Text>
        </Section>

        <Section id="setup" num={setupNum} title="Setup">
          <Text type="supporting">
            Seed <code>{universe.seed}</code>, {universe.tradingDays} trading days from{' '}
            {universe.startDate}, {universe.series.length} fictional tickers (GBM with planted
            crashes/rallies).
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

        <Section id="images" num={imagesNum} title="Images fed to the LLM">
          <Text type="supporting">
            These are the exact chart PNGs used as multimodal user content
            {hasSavedPayload && savedImages.length
              ? ' in the saved runs (byte-identical to what OpenRouter received).'
              : ' when probes run (local canvas previews until a run is published).'}
            {' '}Textless hybrids omit labels; ticker identity lives in the companion markdown key.
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
            Text packs mirror today&apos;s Copilot tool summary. Image encodings are labeled
            charts. Hybrid rows send a textless PNG plus a markdown color key in one probe
            (no OCR). Pick one to inspect the payload.
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
            Each representation answers the same ground-truth prompts (tickers from the
            synthetic panel).
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
