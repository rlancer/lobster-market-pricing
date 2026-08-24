import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  TextInput,
  Token,
  VStack,
} from '@astryxdesign/core';
import { api, type ExperimentRunPayload } from './api';
import { useIsAdmin } from './useAdmin';
import { DEFAULT_PROBE_MODEL } from './notebooks/experiment';
import {
  buildImageRepresentations,
  type ImageRep,
} from './notebooks/imageRepresentations';
import {
  SYSTEM_PROBE,
  buildQuestions,
  scoreAnswer,
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

/** Experiment: Copilot-style text summaries vs chart images for multimodal LLMs. */
export default function TextVsImageNotebookPage() {
  const { isAdmin } = useIsAdmin();
  const [model, setModel] = useState(DEFAULT_PROBE_MODEL);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [localImages, setLocalImages] = useState<ImageRep[]>([]);
  const [savedRun, setSavedRun] = useState<ExperimentRunPayload | null>(null);
  const [runLoadState, setRunLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [runLoadError, setRunLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [selectedRep, setSelectedRep] = useState('tool_summary');
  const [viewSource, setViewSource] = useState<'saved' | 'local'>('saved');

  const universe = useMemo(() => buildSynthUniverse(), []);
  const stats = useMemo(() => universeStats(universe), [universe]);
  const textReps = useMemo(() => buildTextRepresentations(universe), [universe]);
  const questions = useMemo(() => buildQuestions(universe), [universe]);
  const tickers = useMemo(() => universe.series.map((s) => s.ticker), [universe]);

  useEffect(() => {
    try {
      setLocalImages(buildImageRepresentations(universe));
    } catch (error) {
      console.error(error);
      setLocalImages([]);
    }
  }, [universe]);

  useEffect(() => {
    let cancelled = false;
    setRunLoadState('loading');
    setRunLoadError(null);
    api.experimentLatestRun(EXPERIMENT_SLUG)
      .then((run) => {
        if (cancelled) return;
        setSavedRun(run);
        setMatrix(matrixFromRun(run));
        setModel(run.model || DEFAULT_PROBE_MODEL);
        setViewSource('saved');
        setRunLoadState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = String((error as Error)?.message ?? error);
        if (/404|no published run/i.test(message)) {
          setSavedRun(null);
          setRunLoadState('missing');
          setViewSource('local');
        } else {
          setRunLoadState('error');
          setRunLoadError(message);
          setViewSource('local');
        }
      });
    return () => { cancelled = true; };
  }, []);

  const savedImages = useMemo(
    () => (savedRun ? imagesFromRun(savedRun) : []),
    [savedRun],
  );
  const displayImages = viewSource === 'saved' && savedImages.length
    ? savedImages
    : localImages;

  const displayTextReps: TextRep[] = useMemo(() => {
    if (viewSource === 'saved' && savedRun?.results.text_reps?.length) {
      return savedRun.results.text_reps.map((r) => ({
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

  const allReps: Array<TextRep | ImageRep> = useMemo(
    () => [...displayTextReps, ...displayImages],
    [displayTextReps, displayImages],
  );
  const repIds = useMemo(() => {
    if (viewSource === 'saved' && savedRun?.results.rep_order?.length) {
      return savedRun.results.rep_order;
    }
    return allReps.map((r) => r.id);
  }, [viewSource, savedRun, allReps]);

  useEffect(() => {
    if (!repIds.length || viewSource === 'saved') return;
    setMatrix((prev) => (Object.keys(prev).length
      ? prev
      : emptyMatrix(repIds, questions.map((q) => q.id))));
  }, [repIds, questions, viewSource]);

  const selectedText = displayTextReps.find((r) => r.id === selectedRep) ?? null;
  const selectedImage = displayImages.find((r) => r.id === selectedRep) ?? null;

  const updateCell = (repId: string, questionId: string, patch: Partial<ProbeCell>) => {
    setMatrix((prev) => ({
      ...prev,
      [repId]: {
        ...prev[repId],
        [questionId]: { ...(prev[repId]?.[questionId] ?? { status: 'idle' }), ...patch },
      },
    }));
  };

  const runOne = async (repId: string, question: ExperimentQuestion) => {
    const text = textReps.find((r) => r.id === repId);
    const image = localImages.find((r) => r.id === repId);
    updateCell(repId, question.id, { status: 'running', error: undefined });
    try {
      const result = text
        ? await api.adminNotebookProbe({
            model,
            mode: 'text',
            question: question.prompt,
            system: SYSTEM_PROBE,
            text_context: text.body,
          })
        : await api.adminNotebookProbe({
            model,
            mode: 'image',
            question: question.prompt,
            system: SYSTEM_PROBE,
            image_data_url: image!.dataUrl,
          });
      const scored = scoreAnswer(question, result.answer, tickers);
      updateCell(repId, question.id, {
        status: 'done',
        answer: result.answer,
        correct: scored.correct,
        detail: scored.detail,
        latencyMs: result.latency_ms,
        model: result.model,
      });
    } catch (error) {
      updateCell(repId, question.id, {
        status: 'error',
        error: String((error as Error)?.message ?? error),
      });
    }
  };

  const runAll = async () => {
    setViewSource('local');
    setRunning(true);
    setSaveMessage(null);
    const ids = [...textReps.map((r) => r.id), ...localImages.map((r) => r.id)];
    setMatrix(emptyMatrix(ids, questions.map((q) => q.id)));
    try {
      for (const repId of ids) {
        for (const question of questions) {
          // Sequential to respect OpenRouter rate limits.
          // eslint-disable-next-line no-await-in-loop
          await runOne(repId, question);
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const publishRun = async () => {
    if (!localImages.length) return;
    const ids = [...textReps.map((r) => r.id), ...localImages.map((r) => r.id)];
    const cells = [];
    for (const repId of ids) {
      for (const q of questions) {
        const cell = matrix[repId]?.[q.id];
        if (!cell || (cell.status !== 'done' && cell.status !== 'error')) continue;
        cells.push({
          rep_id: repId,
          question_id: q.id,
          status: cell.status as 'done' | 'error',
          answer: cell.answer,
          correct: cell.correct,
          detail: cell.detail,
          latency_ms: cell.latencyMs,
          error: cell.error,
          model: cell.model,
        });
      }
    }
    if (!cells.length) {
      setSaveMessage('Run the matrix first, then publish.');
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const response = await api.adminSaveExperimentRun(EXPERIMENT_SLUG, {
        experiment_slug: EXPERIMENT_SLUG,
        model,
        seed: universe.seed,
        results: {
          questions: questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            expected: String(q.expected),
          })),
          text_reps: textReps.map((r) => ({
            id: r.id,
            label: r.label,
            description: r.description,
            approx_tokens: r.approxTokens,
            body: r.body,
          })),
          cells,
          rep_order: ids,
        },
        images: localImages.map((img) => ({
          id: img.id,
          label: img.label,
          description: img.description,
          width: img.width,
          height: img.height,
          data_url: img.dataUrl,
        })),
      });
      setSavedRun(response.run);
      setMatrix(matrixFromRun(response.run));
      setViewSource('saved');
      setRunLoadState('ready');
      setSaveMessage(`Published run ${response.run.id.slice(0, 8)}… — visitors load this without probing.`);
    } catch (error) {
      setSaveMessage(String((error as Error)?.message ?? error));
    } finally {
      setSaving(false);
    }
  };

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
          model either as Copilot-style text summaries or as chart images. Answers are
          scored against ground truth so we can see which encodings survive LLM context
          before changing production Copilot framing.
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
            . Viewing this costs nothing — probes already ran on the server.
          </Text>
        ) : null}
        {runLoadState === 'missing' ? (
          <Text type="supporting">
            No published run yet. Methodology and local chart previews are free;
            {isAdmin
              ? ' an admin can run probes and publish results below.'
              : ' check back after an admin publishes results.'}
          </Text>
        ) : null}
        {runLoadState === 'error' ? (
          <Text type="supporting">Could not load saved run: {runLoadError}</Text>
        ) : null}
        {savedRun && localImages.length ? (
          <HStack gap={2} style={{ flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant={viewSource === 'saved' ? 'primary' : 'secondary'}
              label="Published run"
              onClick={() => {
                setViewSource('saved');
                setMatrix(matrixFromRun(savedRun));
              }}
            />
            {isAdmin ? (
              <Button
                size="sm"
                variant={viewSource === 'local' ? 'primary' : 'secondary'}
                label="Live / re-run workspace"
                onClick={() => setViewSource('local')}
              />
            ) : null}
          </HStack>
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
            : ' when probes run (rendered in this browser as canvas PNGs).'}
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
          Text packs mirror today&apos;s Copilot tool summary. Pick one to inspect the
          payload; image encodings are shown above as fed to the model.
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
        {isAdmin ? (
          <>
            <Text type="supporting">
              Admin: run probes via <code>POST /api/admin/notebooks/probe</code>, then publish
              so everyone else loads the saved matrix and images for free.
            </Text>
            <HStack gap={3} style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ minWidth: 280 }}>
                <TextInput
                  label="OpenRouter model"
                  value={model}
                  onChange={setModel}
                />
              </div>
              <Button
                variant="primary"
                label={running ? 'Running…' : 'Run full matrix'}
                isDisabled={running || saving || !localImages.length}
                onClick={() => { void runAll(); }}
              />
              <Button
                variant="secondary"
                label={saving ? 'Publishing…' : 'Publish saved run'}
                isDisabled={running || saving || !localImages.length}
                onClick={() => { void publishRun(); }}
              />
            </HStack>
            {saveMessage ? <Text type="supporting">{saveMessage}</Text> : null}
          </>
        ) : (
          <Text type="supporting">
            Results below come from the published server run when available. Probing
            OpenRouter yourself is disabled here to avoid surprise spend.
          </Text>
        )}

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
          Compare <code>tool_summary</code> (today&apos;s Copilot framing) against the image
          encodings. Ranked bars and small multiples should dominate who-won / who-lost
          questions; heatmaps help regime/crash reads; crowded overlays often lose ticker
          identity. If images beat text on the same multimodal model, production may want
          an optional chart-as-context path for panel questions — without dropping SQL tools.
        </Text>
      </VStack>
    </VStack>
  );
}
