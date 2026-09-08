import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  api,
  type DeskExperimentDesign,
  type ExperimentRunPayload,
  type ExperimentRunSummary,
} from './api';
import {
  FIRM_PIPELINE_DESIGN_ID,
  FIRM_PIPELINE_SLUG,
  FIRM_PIPELINE_CHAT_MODEL,
  buildFirmPipelineConclusion,
  firmApproachLabel,
  firmSessionCountLabel,
  formatDurationMs,
  isChatDeskExperimentModel,
  isDeskCellAborted,
  pct,
  pickLatestChatDeskRun,
} from './notebooks/firmPipeline';
import './Notebooks.css';

type TocEntry = { id: string; num: string; label: string };

const FALLBACK_APPROACHES: DeskExperimentDesign['approaches'] = [
  { id: 'solo', label: 'Solo trader', session_mode: 'one', description: 'One voice, full snapshot.' },
  { id: 'reports_then_trader', label: 'Analyst reports → trader', session_mode: 'reports_then_trader', description: 'Structured reports, no debate.' },
  { id: 'bull_bear_debate', label: 'Bull vs bear research', session_mode: 'bull_bear', description: 'Opposing briefs, then trader.' },
  { id: 'firm_risk_committee', label: 'Full firm pipeline', session_mode: 'firm_pipeline', description: 'Draft, then risk, then fund manager.' },
];

function padNum(index: number): string {
  return String(index + 1).padStart(2, '0');
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

function Accordion({
  title,
  meta,
  children,
  defaultOpen = false,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <VStack gap={2} className="notebook-accordion">
      <button
        type="button"
        className="notebook-accordion-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        <span className="notebook-accordion-title">{title}</span>
        {meta ? <span className="notebook-model-meta">{meta}</span> : null}
      </button>
      {open ? children : null}
    </VStack>
  );
}

function shortModel(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function formatRunWhen(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function sessionCountLabel(mode: string): string {
  return firmSessionCountLabel(mode);
}

function Scoreboard({ runs }: { runs: ExperimentRunPayload[] }) {
  const questions = runs[0]?.results.questions ?? [];
  const repIds = runs[0]?.results.rep_order?.length
    ? runs[0].results.rep_order
    : [...new Set(runs.flatMap((run) => run.results.cells.map((c) => c.rep_id)))];

  return (
    <div className="notebook-results">
      <table>
        <thead>
          <tr>
            <th>Approach</th>
            {runs.map((run) => (
              <th key={run.id}>
                {shortModel(run.model)}
                <div className="notebook-answer">{formatRunWhen(run.created_at)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {repIds.map((repId) => (
            <tr key={repId}>
              <td>{firmApproachLabel(repId)}</td>
              {runs.map((run) => {
                const cells = questions.map(
                  (q) => run.results.cells.find((c) => c.rep_id === repId && c.question_id === q.id),
                );
                const aborted = cells.filter((c) => isDeskCellAborted(c ?? null)).length;
                const done = cells.filter((c) => c && !isDeskCellAborted(c));
                const correct = done.filter((c) => c?.correct).length;
                return (
                  <td key={run.id} className="num">
                    {done.length ? `${correct}/${done.length} · ${pct(correct, done.length)}` : '—'}
                    {aborted ? (
                      <div className="notebook-answer">
                        {aborted} abort
                      </div>
                    ) : null}
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

function RunMatrix({ run }: { run: ExperimentRunPayload }) {
  const questions = run.results.questions;
  const repIds = run.results.rep_order.length
    ? run.results.rep_order
    : [...new Set(run.results.cells.map((c) => c.rep_id))];

  return (
    <div className="notebook-results">
      <table>
        <thead>
          <tr>
            <th>Approach</th>
            <th>Sessions</th>
            {questions.map((q) => (
              <th key={q.id}>{q.id}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {repIds.map((repId) => {
            const sample = run.results.cells.find((c) => c.rep_id === repId);
            return (
              <tr key={repId}>
                <td>{firmApproachLabel(repId)}</td>
                <td className="num">{sample?.session_count ?? '—'}</td>
                {questions.map((q) => {
                  const cell = run.results.cells.find(
                    (c) => c.rep_id === repId && c.question_id === q.id,
                  );
                  if (!cell || isDeskCellAborted(cell)) {
                    return (
                      <td key={q.id}>
                        <Token label="abort" color="red" size="sm" />
                        {cell?.detail || cell?.error ? (
                          <span className="notebook-answer">{cell.detail ?? cell.error}</span>
                        ) : null}
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
                        <span className="notebook-answer">
                          {cell.lean_5d ?? '—'} / {cell.lean_20d ?? '—'}
                        </span>
                      </VStack>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CellDetails({ run }: { run: ExperimentRunPayload }) {
  const questions = run.results.questions;
  const repIds = run.results.rep_order.length
    ? run.results.rep_order
    : [...new Set(run.results.cells.map((c) => c.rep_id))];

  return (
    <VStack gap={2}>
      {repIds.map((repId) => (
        <Accordion
          key={repId}
          title={firmApproachLabel(repId)}
          meta={`${run.results.cells.filter((c) => c.rep_id === repId && !isDeskCellAborted(c)).length}/${questions.length} finished`}
        >
          {questions.map((q) => {
            const cell = run.results.cells.find(
              (c) => c.rep_id === repId && c.question_id === q.id,
            );
            return (
              <Accordion
                key={`${repId}-${q.id}`}
                title={q.id}
                meta={
                  !cell || isDeskCellAborted(cell)
                    ? 'abort'
                    : (cell.correct ? 'ok' : 'miss')
                }
              >
                <Text type="supporting">{q.prompt}</Text>
                {cell?.detail ? <Text type="supporting">{cell.detail}</Text> : null}
                {cell?.error ? (
                  <pre className="notebook-code">{cell.error}</pre>
                ) : (
                  <pre className="notebook-code">{cell?.answer ?? '(no answer)'}</pre>
                )}
              </Accordion>
            );
          })}
        </Accordion>
      ))}
    </VStack>
  );
}

function ApproachInputs({ design }: { design: DeskExperimentDesign }) {
  const inputs = design.approach_inputs ?? [];
  const byId = new Map(inputs.map((row) => [row.id, row]));

  return (
    <VStack gap={2}>
      {(design.approaches.length ? design.approaches : FALLBACK_APPROACHES).map((row) => {
        const input = byId.get(row.id);
        return (
          <Accordion
            key={row.id}
            title={row.label}
            meta={`${sessionCountLabel(row.session_mode)} session${row.session_mode === 'one' ? '' : 's'}`}
          >
            <Text type="supporting">{row.description}</Text>
            {input?.system_prompt ? (
              <>
                <Text type="supporting">System prompt sent on the first turn</Text>
                <pre className="notebook-code">{input.system_prompt}</pre>
              </>
            ) : null}
            {input?.specialist_turns?.map((turn) => (
              <Accordion key={turn.id} title={`${turn.label} seat instruction`}>
                <pre className="notebook-code">{turn.user_instruction}</pre>
              </Accordion>
            ))}
            {input?.chair_turn ? (
              <Accordion title="Chair turn">
                <pre className="notebook-code">{input.chair_turn}</pre>
              </Accordion>
            ) : null}
            {input?.specialist_system
              ? Object.entries(input.specialist_system).map(([id, prompt]) => (
                <Accordion key={id} title={`${id} system (fresh session)`}>
                  <pre className="notebook-code">{prompt}</pre>
                </Accordion>
              ))
              : null}
            {input?.chair_system ? (
              <Accordion title="Trader / chair system">
                <pre className="notebook-code">{input.chair_system}</pre>
              </Accordion>
            ) : null}
            {input?.bull_system ? (
              <Accordion title="Bull researcher system">
                <pre className="notebook-code">{input.bull_system}</pre>
              </Accordion>
            ) : null}
            {input?.bear_system ? (
              <Accordion title="Bear researcher system">
                <pre className="notebook-code">{input.bear_system}</pre>
              </Accordion>
            ) : null}
            {input?.risk_aggressive_system ? (
              <Accordion title="Risk-seeking guardian">
                <pre className="notebook-code">{input.risk_aggressive_system}</pre>
              </Accordion>
            ) : null}
            {input?.risk_conservative_system ? (
              <Accordion title="Risk-conservative guardian">
                <pre className="notebook-code">{input.risk_conservative_system}</pre>
              </Accordion>
            ) : null}
            {input?.fund_manager_system ? (
              <Accordion title="Fund manager system">
                <pre className="notebook-code">{input.fund_manager_system}</pre>
              </Accordion>
            ) : null}
          </Accordion>
        );
      })}
    </VStack>
  );
}

export default function FirmPipelineNotebookPage() {
  const [design, setDesign] = useState<DeskExperimentDesign | null>(null);
  const [runs, setRuns] = useState<ExperimentRunPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('overview');
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.firmPipelineDesign();
        if (!cancelled) setDesign(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const list = await api.experimentListRuns(FIRM_PIPELINE_SLUG, 20, FIRM_PIPELINE_DESIGN_ID);
        const items: ExperimentRunSummary[] = list.items ?? [];
        const loaded = await Promise.all(
          items.map((row) =>
            api.experimentRun(FIRM_PIPELINE_SLUG, row.id, {
              images: false,
              designId: FIRM_PIPELINE_DESIGN_ID,
            }),
          ),
        );
        if (!cancelled) setRuns(loaded.filter((run) => run.results.design_id === FIRM_PIPELINE_DESIGN_ID));
      } catch {
        /* no published run yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scoredRuns = useMemo(() => {
    return [...runs]
      .filter((run) => isChatDeskExperimentModel(run.model, design?.model))
      .sort((a, b) => b.created_at - a.created_at);
  }, [runs, design]);

  const latestRun = useMemo(
    () => pickLatestChatDeskRun(scoredRuns, design?.model),
    [scoredRuns, design],
  );
  const conclusion = useMemo(
    () => buildFirmPipelineConclusion(latestRun),
    [latestRun],
  );

  const toc = useMemo<TocEntry[]>(() => {
    const entries: Array<{ id: string; label: string }> = [
      { id: 'overview', label: 'Overview' },
      { id: 'paper', label: 'From the paper' },
      { id: 'results', label: 'Results' },
      ...scoredRuns.map((run) => ({ id: `model-${run.id}`, label: shortModel(run.model) })),
      { id: 'reading', label: 'How to read' },
      { id: 'setup', label: 'Setup' },
      { id: 'approaches', label: 'Approaches' },
      { id: 'inputs', label: 'Input data' },
      { id: 'conclusion', label: 'Conclusion' },
    ];
    return entries.map((entry, index) => ({ ...entry, num: padNum(index) }));
  }, [scoredRuns]);

  const tocById = useMemo(() => new Map(toc.map((entry) => [entry.id, entry])), [toc]);

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
      { root: null, rootMargin: '0px 0px -65% 0px', threshold: [0.1, 0.25, 0.5] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [toc]);

  const toggleRun = (id: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandRun = (id: string) => {
    setExpandedRuns((prev) => new Set(prev).add(id));
  };

  const overviewNum = tocById.get('overview')?.num ?? '01';
  const paperNum = tocById.get('paper')?.num ?? '02';
  const resultsNum = tocById.get('results')?.num ?? '03';
  const readingNum = tocById.get('reading')?.num ?? '03';
  const setupNum = tocById.get('setup')?.num ?? '04';
  const approachesNum = tocById.get('approaches')?.num ?? '05';
  const inputsNum = tocById.get('inputs')?.num ?? '06';
  const conclusionNum = tocById.get('conclusion')?.num ?? '07';

  return (
    <div className="notebook-layout">
      <VStack gap={6}>
        <VStack gap={2}>
          <Text type="supporting">
            <Link to="/experiments">Experiments</Link>
            {' · '}
            Firm pipeline
          </Text>
          <Heading level={1}>Trading firm pipeline</Heading>
          <Text type="supporting">
            Do TradingAgents-style stages — structured analyst reports, bull/bear research,
            a later risk committee — beat a solo take on the same frozen as-of tape?
          </Text>
        </VStack>

        <Section id="overview" num={overviewNum} title="Overview">
          <Text>
            Xiao et al. (arXiv:2412.20138) argue that a simulated trading firm — specialized
            analysts, bull and bear researchers, a trader, then a risk committee — outperforms
            rule-based baselines on AAPL, GOOGL, and AMZN. That eval cannot tell us whether the
            <em>protocol</em> is doing the work: the names are real, the baselines are MACD/SMA,
            and there is no ablation of debate versus reports versus risk-after-decision.
          </Text>
          <Text>
            This study reuses the desk-approaches invented-ticker cases. Same as-of clip, same
            held-out 5d/20d continuation, same 1.5% deadband. The only variable is pipeline
            stage. Independent seats in a wave run in parallel; downstream seats see structured
            reports, not an ever-growing chat.
          </Text>
          {design ? <Text type="supporting">{design.production_note}</Text> : null}
          {design?.shared_with_desk_approaches ? (
            <Text type="supporting">{design.shared_with_desk_approaches.note}</Text>
          ) : null}
          {design?.model ? (
            <Text type="supporting">
              Probes use the same model as live Chat: <code>{design.model}</code>
            </Text>
          ) : null}
          {scoredRuns.length ? (
            <Text type="supporting">
              {scoredRuns.length} Chat run{scoredRuns.length === 1 ? '' : 's'} published —
              per-run matrices start collapsed. Setup and input packets are below the results.
            </Text>
          ) : null}
        </Section>

        <Section id="paper" num={paperNum} title="From the paper">
          <Text type="supporting">
            {design?.paper?.citation
              ?? 'Xiao, Sun, Luo, Wang. TradingAgents: Multi-Agents LLM Financial Trading Framework. arXiv:2412.20138.'}
          </Text>
          <Text>
            We keep the organizational claim and drop the eval that cannot isolate it.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Keep from TradingAgents</th>
                  <th>Reject (do the harder eval)</th>
                </tr>
              </thead>
              <tbody>
                {(design?.paper?.keep ?? [
                  'Role specialization.',
                  'Structured reports instead of a telephone-effect chat.',
                  'Bull vs bear as an explicit dialectic.',
                  'Risk as a committee after the trader draft.',
                ]).map((row, i) => (
                  <tr key={row}>
                    <td>{row}</td>
                    <td>
                      {(design?.paper?.reject ?? [
                        'P&L on 2024 mega-cap names.',
                        'MACD/SMA/B&H as the only baselines.',
                        'Live news APIs on a frozen question.',
                        'Sharpe as the primary grade on four as-of cases.',
                      ])[i] ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {design?.stages?.length ? (
            <div className="notebook-results">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>What it does here</th>
                  </tr>
                </thead>
                <tbody>
                  {design.stages.map((row) => (
                    <tr key={row.id}>
                      <td>{row.label}</td>
                      <td>{row.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Section>

        <Section id="results" num={resultsNum} title="Results">
          {scoredRuns.length ? (
            <>
              <Text type="supporting">{conclusion.summary}</Text>
              <Scoreboard runs={scoredRuns} />
            </>
          ) : (
            <Text type="supporting">
              No published Chat-model run yet. Admin CI probes seats in-process against
              OpenRouter, then saves a run so this page can grade approaches without spending
              credits in the browser.
            </Text>
          )}
          {design?.model ? (
            <Text type="supporting">
              Scoreboard is live Chat only (<code>{design.model}</code>). Other probe models are
              out of scope.
            </Text>
          ) : null}
        </Section>

        {scoredRuns.map((run) => {
          const entry = tocById.get(`model-${run.id}`);
          const expanded = expandedRuns.has(run.id);
          const done = run.results.cells.filter((cell) => !isDeskCellAborted(cell));
          const correct = done.filter((cell) => cell.correct).length;
          const meta = [
            formatRunWhen(run.created_at),
            done.length ? `${correct}/${done.length}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <section key={run.id} id={`model-${run.id}`} className="notebook-section notebook-model-section">
              <button
                type="button"
                className="notebook-model-toggle"
                aria-expanded={expanded}
                onClick={() => toggleRun(run.id)}
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
                    <code>{run.model}</code>
                    {' · seed '}
                    <code>{run.seed}</code>
                    {' · design '}
                    <code>{run.results.design_id}</code>
                    {run.results.manifest.source_revision ? (
                      <>
                        {' · source '}
                        <code>{run.results.manifest.source_revision.slice(0, 12)}</code>
                      </>
                    ) : null}
                  </Text>
                  <RunMatrix run={run} />
                  <Accordion title="Cell traces" meta="raw answers, errors, and prompts">
                    <CellDetails run={run} />
                  </Accordion>
                </VStack>
              ) : (
                <Text type="supporting">
                  Collapsed — expand here or jump from the table of contents.
                </Text>
              )}
            </section>
          );
        })}

        <Section id="reading" num={readingNum} title="How to read">
          <Text>
            A cell is correct only when both the 5-session and 20-session leans match the
            held-out tape. That tape continues what is already visible at as-of. Neutral
            is the right call when the subsequent move is inside the deadband — not a
            hedge for a missed direction.
          </Text>
          <Text>
            If reports match solo, extra analysts are cost without a better lean. If bull/bear
            beats reports-only, the dialectic is doing work beyond more seats. If the later
            risk committee beats stopping at the trader, risk-after-decision is not the same
            as production's parallel risk specialist. A seat abort is operational, not a
            wrong lean.
          </Text>
        </Section>

        <Section id="setup" num={setupNum} title="Setup">
          <Text type="supporting">
            Design <code>{design?.design_id ?? FIRM_PIPELINE_DESIGN_ID}</code> reuses the
            desk-approaches-v2 invented-ticker tape so the two studies can be read together.
            Seed{' '}
            <code>{design?.seed_hex ?? '0x4d45534b'}</code>,{' '}
            {design?.trading_days ?? 90} trading days from {design?.start_date ?? '2026-01-05'},
            as-of bar index {design?.as_of_index ?? 69}. Runner version{' '}
            {design?.runner_version ?? 1}.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Knob</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Chat model</td>
                  <td><code>{design?.model ?? FIRM_PIPELINE_CHAT_MODEL}</code></td>
                </tr>
                <tr>
                  <td>Deadband</td>
                  <td>{design?.deadband_pct ?? 1.5}%</td>
                </tr>
                <tr>
                  <td>Seat abort</td>
                  <td>{formatDurationMs(design?.runner?.seat_abort_ms ?? 12 * 60_000)}</td>
                </tr>
                <tr>
                  <td>Verdict close-out</td>
                  <td>
                    {formatDurationMs(design?.runner?.verdict_close_abort_ms ?? 45_000)}
                    {', reasoning none, '}
                    {design?.runner?.verdict_close_max_tokens ?? 384} tokens
                  </td>
                </tr>
                <tr>
                  <td>Cell cap</td>
                  <td>{formatDurationMs(design?.runner?.cell_timeout_ms ?? 45 * 60_000)}</td>
                </tr>
                <tr>
                  <td>Execution</td>
                  <td>
                    {design?.runner?.execution
                      ?? 'In-process OpenRouter from GitHub Actions; independent seats in a wave run in parallel.'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {design?.scoring ? (
            <Text type="supporting">{design.scoring.rule}</Text>
          ) : null}
          <Accordion title="As-of rules, verdict JSON, and shared system prompt" meta="sent on every approach">
            {design?.as_of_rules ? (
              <>
                <Text type="supporting">As-of rules</Text>
                <pre className="notebook-code">{design.as_of_rules}</pre>
              </>
            ) : null}
            {design?.verdict_instructions ? (
              <>
                <Text type="supporting">Verdict JSON</Text>
                <pre className="notebook-code">{design.verdict_instructions}</pre>
              </>
            ) : null}
            {design?.system_prompt ? (
              <>
                <Text type="supporting">Manifest system prompt</Text>
                <pre className="notebook-code">{design.system_prompt}</pre>
              </>
            ) : null}
          </Accordion>
          <Accordion title="Runner implementation notes" meta="OpenRouter + close-out">
            {design?.runner ? (
              <VStack gap={2}>
                <Text type="supporting">{design.runner.openrouter_system}</Text>
                <Text type="supporting">{design.runner.verdict_close_out}</Text>
                <Text type="supporting">{design.runner.completion_text}</Text>
              </VStack>
            ) : (
              <Text type="supporting">
                System turns fold into <code>generateText({'{ system }'})</code>. Verdict
                close-out uses reasoning none. Grade <code>text</code> union{' '}
                <code>reasoningText</code>. Do not use <code>generateObject</code> on flash.
              </Text>
            )}
          </Accordion>
              <Accordion title="Specialist briefs" meta={`${design?.specialists?.length ?? 4} analyst seats`}>
            <div className="notebook-results">
              <table>
                <thead>
                  <tr>
                    <th>Seat</th>
                    <th>Brief</th>
                  </tr>
                </thead>
                <tbody>
                  {(design?.specialists ?? []).map((row) => (
                    <tr key={row.id}>
                      <td>{row.label}</td>
                      <td>{row.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Accordion>
        </Section>

        <Section id="approaches" num={approachesNum} title="Approaches">
          <Text type="supporting">
            Same frozen packet on every arm. Stages accumulate: reports-only is the
            control for debate; debate is the control for the later risk committee.
            Expand an approach to see the exact system prompts the runner sends.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Approach</th>
                  <th>Sessions</th>
                  <th>What it tests</th>
                </tr>
              </thead>
              <tbody>
                {(design?.approaches ?? FALLBACK_APPROACHES).map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td>{sessionCountLabel(row.session_mode)}</td>
                    <td>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {design ? <ApproachInputs design={design} /> : null}
        </Section>

        <Section id="inputs" num={inputsNum} title="Input data">
          <Text type="supporting">
            Deadband {design?.deadband_pct ?? 1.5}%: inside that band the grade is neutral.
            Snapshot OHLC and news stop on as-of; option expirations and scheduled earnings
            after as-of are allowed because they were knowable that day. Each accordion is
            the exact user packet — expand to read the full OHLC, options, news, and question.
          </Text>
          <div className="notebook-results">
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>As of</th>
                  <th>5d</th>
                  <th>20d</th>
                  <th>What happened (held out)</th>
                </tr>
              </thead>
              <tbody>
                {(design?.cases ?? []).map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.ticker}
                      <Text type="supporting">{row.name}</Text>
                    </td>
                    <td>{row.as_of}</td>
                    <td className="num">
                      {row.expected_5d} ({row.return_5d_pct.toFixed(1)}%)
                    </td>
                    <td className="num">
                      {row.expected_20d} ({row.return_20d_pct.toFixed(1)}%)
                    </td>
                    <td>{row.what_happened}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(design?.cases ?? []).map((row) => (
            <Accordion
              key={row.id}
              title={`${row.ticker} — ${row.name}`}
              meta={`${row.id} · ${row.as_of} · ${row.snapshot_text.length.toLocaleString()} chars`}
            >
              <Text type="supporting">{row.notes}</Text>
              <Text type="supporting">Question</Text>
              <pre className="notebook-code">{row.prompt}</pre>
              <Text type="supporting">User packet (snapshot + question)</Text>
              <pre className="notebook-code">{row.user_packet ?? row.snapshot_text}</pre>
            </Accordion>
          ))}
          {error ? (
            <Text type="supporting">Design endpoint unavailable ({error}). Cases load from the Worker.</Text>
          ) : null}
        </Section>

        <Section id="conclusion" num={conclusionNum} title="Conclusion">
          <Text>{conclusion.wrapUp}</Text>
          {conclusion.byApproach.length ? (
            <div className="notebook-results">
              <table>
                <thead>
                  <tr>
                    <th>Approach</th>
                    <th className="num">Finished</th>
                    <th className="num">Wrong</th>
                    <th className="num">Aborted</th>
                  </tr>
                </thead>
                <tbody>
                  {conclusion.byApproach.map((row) => (
                    <tr
                      key={row.approachId}
                      className={
                        conclusion.winningApproaches.includes(row.approachId)
                          ? 'notebook-row-winner'
                          : undefined
                      }
                    >
                      <td>{row.label}</td>
                      <td className="num">{row.done ? `${row.correct}/${row.done}` : '—'}</td>
                      <td className="num">{row.wrong}</td>
                      <td className="num">
                        {row.aborted
                          ? `${row.aborted} (${row.abortedCases.join(', ')})`
                          : '0'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Section>
      </VStack>

      <nav className="notebook-toc" aria-label="On this page">
        <span className="notebook-toc-title">On this page</span>
        {toc.map((entry) => (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            className={activeSection === entry.id ? 'active' : undefined}
            onClick={() => {
              if (entry.id.startsWith('model-')) {
                expandRun(entry.id.slice('model-'.length));
              }
            }}
          >
            <span className="notebook-toc-link">
              <span className="notebook-toc-num">{entry.num}</span>
              {entry.label}
            </span>
          </a>
        ))}
      </nav>
    </div>
  );
}
