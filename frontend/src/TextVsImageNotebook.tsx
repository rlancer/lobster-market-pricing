import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Text,
  TextInput,
  Token,
  VStack,
} from '@astryxdesign/core';
import { api } from './api';
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

/** Notebook: Copilot-style text summaries vs chart images for multimodal LLMs. */
export default function TextVsImageNotebookPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [model, setModel] = useState(DEFAULT_PROBE_MODEL);
  const [running, setRunning] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [images, setImages] = useState<ImageRep[]>([]);
  const [selectedRep, setSelectedRep] = useState('tool_summary');

  const universe = useMemo(() => buildSynthUniverse(), []);
  const stats = useMemo(() => universeStats(universe), [universe]);
  const textReps = useMemo(() => buildTextRepresentations(universe), [universe]);
  const questions = useMemo(() => buildQuestions(universe), [universe]);
  const tickers = useMemo(() => universe.series.map((s) => s.ticker), [universe]);

  useEffect(() => {
    if (!isPending && !isAdmin) void navigate({ to: '/' });
  }, [isAdmin, isPending, navigate]);

  useEffect(() => {
    try {
      setImages(buildImageRepresentations(universe));
    } catch (error) {
      console.error(error);
      setImages([]);
    }
  }, [universe]);

  const allReps: Array<TextRep | ImageRep> = useMemo(
    () => [...textReps, ...images],
    [textReps, images],
  );
  const repIds = allReps.map((r) => r.id);

  useEffect(() => {
    if (!repIds.length) return;
    setMatrix((prev) => (Object.keys(prev).length
      ? prev
      : emptyMatrix(repIds, questions.map((q) => q.id))));
  }, [repIds, questions]);

  const selectedText = textReps.find((r) => r.id === selectedRep) ?? null;
  const selectedImage = images.find((r) => r.id === selectedRep) ?? null;

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
    const image = images.find((r) => r.id === repId);
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
    setRunning(true);
    setMatrix(emptyMatrix(repIds, questions.map((q) => q.id)));
    try {
      for (const repId of repIds) {
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

  if (isPending || !isAdmin) {
    return (
      <VStack className="notebook-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  const summaryRows = repIds.map((repId) => {
    const cells = questions.map((q) => matrix[repId]?.[q.id] ?? { status: 'idle' as const });
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

  return (
    <VStack className="notebook-page" gap={6} paddingBlock={6} paddingInline={5} maxWidth={1100}>
      <VStack className="notebook-hero" gap={2}>
        <Text type="supporting">
          <Link to="/notebooks">Notebooks</Link>
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
        <Heading level={2}>2. Representations</Heading>
        <Text type="supporting">
          Text packs mirror today&apos;s Copilot tool summary. Image packs are canvas PNGs
          rendered here and sent as multimodal user content.
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
        <Heading level={2}>3. Questions</Heading>
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
              {questions.map((q) => (
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
        <Heading level={2}>4. Run probes</Heading>
        <Text type="supporting">
          Calls <code>POST /api/admin/notebooks/probe</code> once per representation × question
          (sequential). Default multimodal model: <code>{DEFAULT_PROBE_MODEL}</code>.
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
            isDisabled={running || !images.length}
            onClick={() => { void runAll(); }}
          />
        </HStack>

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
      </VStack>

      <VStack className="notebook-section" gap={2}>
        <Heading level={2}>5. Reading the results</Heading>
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
