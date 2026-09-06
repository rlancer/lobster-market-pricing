import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { api, type ExperimentRunPayload, type ExperimentRunSummary } from './api';
import {
  DESK_EXPERIMENT_DESIGN_ID,
  DESK_EXPERIMENT_SLUG,
  approachLabel,
  pct,
} from './notebooks/deskApproaches';
import './Notebooks.css';

interface DesignCase {
  id: string;
  ticker: string;
  name: string;
  as_of: string;
  prompt: string;
  notes: string;
  expected_5d: string;
  expected_20d: string;
  return_5d_pct: number;
  return_20d_pct: number;
  what_happened: string;
}

interface DesignApproach {
  id: string;
  label: string;
  description: string;
  session_mode: string;
}

interface DesignPayload {
  design_id: string;
  production_note: string;
  as_of_rules: string;
  deadband_pct: number;
  approaches: DesignApproach[];
  cases: DesignCase[];
}

type TocEntry = { id: string; num: string; label: string };

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

function shortModel(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function formatRunWhen(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
              <th key={run.id}>{shortModel(run.model)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {repIds.map((repId) => (
            <tr key={repId}>
              <td>{approachLabel(repId)}</td>
              {runs.map((run) => {
                const cells = questions.map(
                  (q) => run.results.cells.find((c) => c.rep_id === repId && c.question_id === q.id),
                );
                const done = cells.filter((c) => c?.status === 'done');
                const correct = done.filter((c) => c?.correct).length;
                return (
                  <td key={run.id} className="num">
                    {done.length ? `${correct}/${done.length} · ${pct(correct, done.length)}` : '—'}
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
                <td>{approachLabel(repId)}</td>
                <td className="num">{sample?.session_count ?? '—'}</td>
                {questions.map((q) => {
                  const cell = run.results.cells.find(
                    (c) => c.rep_id === repId && c.question_id === q.id,
                  );
                  if (!cell || cell.status !== 'done') {
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

export default function DeskApproachesNotebookPage() {
  const [design, setDesign] = useState<DesignPayload | null>(null);
  const [runs, setRuns] = useState<ExperimentRunPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState('overview');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.deskExperimentDesign();
        if (!cancelled) setDesign(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      try {
        const list = await api.experimentListRuns(DESK_EXPERIMENT_SLUG, 20, DESK_EXPERIMENT_DESIGN_ID);
        const items: ExperimentRunSummary[] = list.items ?? [];
        const loaded = await Promise.all(
          items.map((row) =>
            api.experimentRun(DESK_EXPERIMENT_SLUG, row.id, {
              images: false,
              designId: DESK_EXPERIMENT_DESIGN_ID,
            }),
          ),
        );
        if (!cancelled) setRuns(loaded.filter((run) => run.results.design_id === DESK_EXPERIMENT_DESIGN_ID));
      } catch {
        /* no published run yet */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toc = useMemo<TocEntry[]>(() => {
    const entries: Array<{ id: string; label: string }> = [
      { id: 'overview', label: 'Overview' },
      { id: 'approaches', label: 'Approaches' },
      { id: 'cases', label: 'As-of cases' },
      { id: 'results', label: 'Results' },
      ...runs.map((run) => ({ id: `model-${run.id}`, label: shortModel(run.model) })),
      { id: 'reading', label: 'How to read' },
    ];
    return entries.map((entry, index) => ({ ...entry, num: padNum(index) }));
  }, [runs]);

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

  const overviewNum = toc.find((t) => t.id === 'overview')?.num ?? '01';
  const approachesNum = toc.find((t) => t.id === 'approaches')?.num ?? '02';
  const casesNum = toc.find((t) => t.id === 'cases')?.num ?? '03';
  const resultsNum = toc.find((t) => t.id === 'results')?.num ?? '04';
  const readingNum = toc.find((t) => t.id === 'reading')?.num ?? '05';

  return (
    <div className="notebook-layout">
      <VStack gap={6}>
        <VStack gap={2}>
          <Text type="supporting">
            <Link to="/experiments">Experiments</Link>
            {' · '}
            Desk approaches
          </Text>
          <Heading level={1}>Analyst desk vs sessions</Heading>
          <Text type="supporting">
            Does the multi-analyst desk actually improve the take — and does spawning a new
            session per specialist beat one model role-playing the desk?
          </Text>
        </VStack>

        <Section id="overview" num={overviewNum} title="Overview">
          <Text>
            Production Chat publishes an Analyst desk via <code>publish_desk</code> inside a
            single CopilotAgent conversation. That is one Durable Object, one model, and
            specialists as seats in a prompt — not four agents. This study freezes the evidence
            pack at an as-of date, hides the next 5 and 20 sessions, and scores directional
            leans against those held-out returns.
          </Text>
          <Text>
            Tickers are invented so the model cannot recall a real outcome. Every approach
            sees the same snapshot text. The only variable is session structure.
          </Text>
          {design ? <Text type="supporting">{design.production_note}</Text> : null}
        </Section>

        <Section id="approaches" num={approachesNum} title="Approaches">
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
                {(design?.approaches ?? [
                  { id: 'solo', label: 'Solo analyst', session_mode: 'one', description: 'One voice, no desk.' },
                  { id: 'desk_roleplay', label: 'Analyst desk role-play', session_mode: 'one', description: 'Current production.' },
                  { id: 'desk_shared_session', label: 'Shared session specialists', session_mode: 'shared_turns', description: 'Turns in one chat.' },
                  { id: 'desk_fresh_sessions', label: 'New session per specialist', session_mode: 'fresh_per_specialist', description: 'Isolated specialists + chair.' },
                ]).map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td>{row.session_mode === 'fresh_per_specialist' ? '5' : '1'}</td>
                    <td>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="cases" num={casesNum} title="As-of cases">
          <Text type="supporting">
            Deadband {design?.deadband_pct ?? 1.5}%: inside that band the grade is neutral.
            Snapshot OHLC and news stop on as-of; option expirations and scheduled earnings
            after as-of are allowed because they were knowable that day.
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
          {error ? (
            <Text type="supporting">Design endpoint unavailable ({error}). Cases load from the Worker.</Text>
          ) : null}
        </Section>

        <Section id="results" num={resultsNum} title="Results">
          {runs.length ? (
            <Scoreboard runs={runs} />
          ) : (
            <Text type="supporting">
              No published run yet. Admin CI probes{' '}
              <code>POST /api/admin/experiments/desk-approaches/probe</code> then saves a run
              so this page can grade approaches without spending OpenRouter credits in the browser.
            </Text>
          )}
        </Section>

        {runs.map((run) => {
          const entry = toc.find((t) => t.id === `model-${run.id}`);
          return (
            <Section
              key={run.id}
              id={`model-${run.id}`}
              num={entry?.num ?? '—'}
              title={shortModel(run.model)}
            >
              <Text type="supporting">
                {run.model} · {formatRunWhen(run.created_at)}
              </Text>
              <RunMatrix run={run} />
            </Section>
          );
        })}

        <Section id="reading" num={readingNum} title="How to read">
          <Text>
            A cell is correct only when both the 5-session and 20-session leans match the
            held-out tape. Neutral is the right call when the subsequent move is inside the
            deadband — not a hedge for a missed direction.
          </Text>
          <Text>
            If role-play matches or beats fresh sessions, the production desk is doing real
            work as a prompt structure. If isolated sessions win, we should actually spawn
            specialists instead of asking one model to wear every hat.
          </Text>
        </Section>
      </VStack>

      <nav className="notebook-toc" aria-label="On this page">
        <span className="notebook-toc-title">On this page</span>
        {toc.map((entry) => (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            className={activeSection === entry.id ? 'active' : undefined}
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
