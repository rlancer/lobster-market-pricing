import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
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

/**
 * Public read-only experiment page. Probes and publishes are pipeline / API /
 * agent driven (GitHub Action + admin API) — the UI only loads saved runs.
 */
export default function TextVsImageNotebookPage() {
  const [matrix, setMatrix] = useState<Matrix>({});
  const [localImages, setLocalImages] = useState<ImageRep[]>([]);
  const [localHybrids, setLocalHybrids] = useState<HybridRep[]>([]);
  const [savedRun, setSavedRun] = useState<ExperimentRunPayload | null>(null);
  const [runList, setRunList] = useState<ExperimentRunSummary[]>([]);
  const [crossCut, setCrossCut] = useState<CrossModelConclusion | null>(null);
  const [crossCutState, setCrossCutState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [runLoadState, setRunLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [runLoadError, setRunLoadError] = useState<string | null>(null);
  const [selectedRep, setSelectedRep] = useState('tool_summary');

  const applyRun = (run: ExperimentRunPayload) => {
    setSavedRun(run);
    setMatrix(matrixFromRun(run));
    setRunLoadState('ready');
  };

  const refreshRunList = async () => {
    try {
      const listed = await api.experimentListRuns(EXPERIMENT_SLUG, 20);
      setRunList(listed.items);
      return listed.items;
    } catch {
      setRunList([]);
      return [] as ExperimentRunSummary[];
    }
  };

  const loadRunById = async (runId: string) => {
    setRunLoadState('loading');
    setRunLoadError(null);
    try {
      const run = await api.experimentRun(EXPERIMENT_SLUG, runId);
      applyRun(run);
    } catch (error: unknown) {
      setRunLoadState('error');
      setRunLoadError(String((error as Error)?.message ?? error));
    }
  };

  const universe = useMemo(() => buildSynthUniverse(), []);
  const stats = useMemo(() => universeStats(universe), [universe]);
  const textReps = useMemo(() => buildTextRepresentations(universe), [universe]);
  const questions = useMemo(() => buildQuestions(universe), [universe]);

  useEffect(() => {
    let cancelled = false;
    if (!runList.length) {
      setCrossCut(null);
      setCrossCutState('idle');
      return;
    }

    void (async () => {
      setCrossCutState('loading');
      try {
        const enriched: RunSummaryForConclusion[] = [];
        const seenModels = new Set<string>();
        for (const row of runList) {
          if (seenModels.has(row.model)) continue;
          seenModels.add(row.model);
          if (row.rep_accuracy?.length) {
            enriched.push({
              id: row.id,
              model: row.model,
              created_at: row.created_at,
              cells_correct: row.cells_correct,
              cells_done: row.cells_done,
              cells_total: row.cells_total,
              rep_accuracy: row.rep_accuracy,
              rep_order: row.rep_order,
            });
            continue;
          }
          // Older Worker list responses omit per-rep stats — pull results only.
          const full = await api.experimentRun(EXPERIMENT_SLUG, row.id, { images: false });
          const byRep = new Map<string, { correct: number; done: number }>();
          for (const cell of full.results.cells) {
            if (cell.status !== 'done') continue;
            const cur = byRep.get(cell.rep_id) ?? { correct: 0, done: 0 };
            cur.done += 1;
            if (cell.correct) cur.correct += 1;
            byRep.set(cell.rep_id, cur);
          }
          enriched.push({
            id: full.id,
            model: full.model,
            created_at: full.created_at,
            cells_correct: row.cells_correct,
            cells_done: row.cells_done,
            cells_total: row.cells_total,
            rep_order: full.results.rep_order,
            rep_accuracy: (full.results.rep_order.length
              ? full.results.rep_order
              : [...byRep.keys()]
            ).map((repId) => {
              const stats = byRep.get(repId) ?? { correct: 0, done: 0 };
              return { rep_id: repId, correct: stats.correct, done: stats.done };
            }),
          });
        }
        if (cancelled) return;
        setCrossCut(buildCrossModelConclusion(enriched));
        setCrossCutState('ready');
      } catch {
        if (cancelled) return;
        setCrossCut(null);
        setCrossCutState('error');
      }
    })();

    return () => { cancelled = true; };
  }, [runList]);

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
      const items = await refreshRunList();
      if (cancelled) return;
      try {
        const run = items[0]
          ? await api.experimentRun(EXPERIMENT_SLUG, items[0].id)
          : await api.experimentLatestRun(EXPERIMENT_SLUG);
        if (cancelled) return;
        applyRun(run);
      } catch (error: unknown) {
        if (cancelled) return;
        const message = String((error as Error)?.message ?? error);
        if (/404|no published run|run not found/i.test(message)) {
          setSavedRun(null);
          setMatrix({});
          setRunLoadState('missing');
        } else {
          setRunLoadState('error');
          setRunLoadError(message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const viewSource: 'saved' | 'local' = savedRun ? 'saved' : 'local';

  const savedImages = useMemo(
    () => (savedRun ? imagesFromRun(savedRun) : []),
    [savedRun],
  );
  const savedHybrids: HybridRep[] = useMemo(() => {
    if (!savedRun) return [];
    const textById = new Map(
      (savedRun.results.text_reps ?? []).map((r) => [r.id, r]),
    );
    return savedRun.images
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
  }, [savedRun]);

  const displayHybrids = viewSource === 'saved' && savedHybrids.length
    ? savedHybrids
    : localHybrids;

  const displayImages = useMemo(() => {
    const base = viewSource === 'saved' && savedImages.length
      ? savedImages
      : localImages;
    // Gallery shows classic labeled charts plus hybrid textless PNGs.
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
  }, [viewSource, savedImages, localImages, displayHybrids]);

  const displayTextReps: TextRep[] = useMemo(() => {
    if (viewSource === 'saved' && savedRun?.results.text_reps?.length) {
      return savedRun.results.text_reps
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
  }, [viewSource, savedRun, textReps]);

  const displayQuestions: ExperimentQuestion[] = useMemo(() => {
    if (viewSource === 'saved' && savedRun?.results.questions?.length) {
      const byId = new Map(questions.map((q) => [q.id, q]));
      return savedRun.results.questions.map((q) => {
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
  }, [viewSource, savedRun, questions]);

  const allReps: Array<TextRep | ImageRep | HybridRep> = useMemo(
    () => [...displayTextReps, ...displayImages.filter((img) => !isHybridRepId(img.id)), ...displayHybrids],
    [displayTextReps, displayImages, displayHybrids],
  );
  const repIds = useMemo(() => {
    if (viewSource === 'saved' && savedRun?.results.rep_order?.length) {
      return savedRun.results.rep_order;
    }
    return allReps.map((r) => r.id);
  }, [viewSource, savedRun, allReps]);

  const selectedText = displayTextReps.find((r) => r.id === selectedRep) ?? null;
  const selectedHybrid = displayHybrids.find((r) => r.id === selectedRep) ?? null;
  const selectedImage = selectedHybrid
    ? null
    : (displayImages.find((r) => r.id === selectedRep) ?? null);

  const summaryRows = repIds.map((repId) => {
    const cells = displayQuestions.map((q) => matrix[repId]?.[q.id] ?? { status: 'idle' as const });
    const doneCells = cells.filter((c) => c.status === 'done');
    const correct = doneCells.filter((c) => c.correct).length;
    const done = doneCells.length;
    const label = allReps.find((r) => r.id === repId)?.label ?? repId;
    return {
      repId,
      label,
      done,
      correct,
      acc: done ? correct / done : null,
    };
  });

  const savedAt = savedRun
    ? new Date(savedRun.created_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <VStack className="notebook-page" gap={6} paddingBlock={6} paddingInline={5} maxWidth={1100}>
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

      <VStack className="notebook-banner" gap={2}>
        {runLoadState === 'loading' ? (
          <Text type="supporting">Loading published run…</Text>
        ) : null}
        {runLoadState === 'ready' && savedRun ? (
          <Text type="supporting">
            Server-saved run from <strong>{savedAt}</strong>
            {' · '}
            model <code>{savedRun.model}</code>
            {' · '}
            seed <code>{savedRun.seed}</code>
            {' · '}
            id <code>{savedRun.id.slice(0, 8)}</code>
            . Viewing this costs nothing — probes already ran via the experiment pipeline.
          </Text>
        ) : null}
        {runLoadState === 'missing' ? (
          <Text type="supporting">
            No published run yet. Methodology and local chart previews are free;
            results appear after the experiment pipeline or agent publishes a run.
          </Text>
        ) : null}
        {runLoadState === 'error' ? (
          <Text type="supporting">Could not load saved run: {runLoadError}</Text>
        ) : null}
        {runList.length > 0 ? (
          <VStack gap={2}>
            <Text type="supporting">
              Saved runs (newest first) — select one to load its answers and the exact images
              that model saw:
            </Text>
            <div className="notebook-results">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Model</th>
                    <th>Accuracy</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {runList.map((row) => {
                    const when = new Date(row.created_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    });
                    const acc = row.cells_done
                      ? `${row.cells_correct}/${row.cells_done}`
                      : '—';
                    const selected = savedRun?.id === row.id;
                    return (
                      <tr key={row.id}>
                        <td>{when}</td>
                        <td><code>{row.model}</code></td>
                        <td className="num">{acc}</td>
                        <td>
                          <Button
                            size="sm"
                            variant={selected ? 'primary' : 'secondary'}
                            label={selected ? 'Viewing' : 'Load'}
                            isDisabled={selected || runLoadState === 'loading'}
                            onClick={() => { void loadRunById(row.id); }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </VStack>
        ) : null}
      </VStack>

      <VStack className="notebook-section notebook-crosscut" gap={3}>
        <Heading level={2}>Cross-model conclusion</Heading>
        {crossCutState === 'loading' || crossCutState === 'idle' ? (
          <Text type="supporting">Aggregating published runs…</Text>
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
                        <code>{m.model.includes('/') ? m.model.split('/')[1] : m.model}</code>
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
      </VStack>

      <VStack className="notebook-section" gap={3}>
        <Heading level={2}>1. Setup</Heading>
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
      </VStack>

      <VStack className="notebook-section" gap={3}>
        <Heading level={2}>2. Images fed to the LLM</Heading>
        <Text type="supporting">
          These are the exact chart PNGs used as multimodal user content
          {viewSource === 'saved' && savedImages.length
            ? ' in the published run (byte-identical to what OpenRouter received).'
            : ' for this experiment (rendered locally as canvas PNGs until a run is published).'}
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
      </VStack>

      <VStack className="notebook-section" gap={3}>
        <Heading level={2}>3. Representations</Heading>
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
      </VStack>

      <VStack className="notebook-section" gap={3}>
        <Heading level={2}>4. Questions</Heading>
        <Text type="supporting">
          Eight graded prompts with deterministic answers. Scoring is client-side — no judge model.
        </Text>
        <div className="notebook-results">
          <table>
            <thead>
              <tr>
                <th>ID</th>
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
      </VStack>

      <VStack className="notebook-section" gap={3}>
        <Heading level={2}>5. Results</Heading>
        <Text type="supporting">
          Results below come from the published server run when available. Probing and
          publishing are driven by the experiment pipeline / API / agents — not from this page.
        </Text>

        <div className="notebook-results">
          <table>
            <thead>
              <tr>
                <th>Representation</th>
                <th>Correct</th>
                <th>Accuracy</th>
                {displayQuestions.map((q) => (
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
                  {displayQuestions.map((q) => {
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
      </VStack>

      <VStack className="notebook-section" gap={2}>
        <Heading level={2}>6. Reading the results</Heading>
        <Text type="supporting">
          Compare <code>tool_summary</code> (today&apos;s Copilot framing) against labeled
          image encodings and the hybrid <code>*_color_keyed</code> rows (textless chart +
          markdown color key). If hybrids beat labeled images on the same model, OCR was the
          bottleneck — production can send color legends in text and keep charts visual-only.
          Ranked bars and small multiples should dominate who-won / who-lost questions;
          heatmaps help regime/crash reads; crowded overlays often lose ticker identity.
        </Text>
      </VStack>
    </VStack>
  );
}
