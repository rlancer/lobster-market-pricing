import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approachLabel,
  buildDeskApproachesConclusion,
  formatDurationMs,
  isChatDeskExperimentModel,
  pct,
  pickLatestChatDeskRun,
  type DeskRunForConclusion,
} from './deskApproaches.ts';

test('approachLabel names production role-play vs fresh sessions', () => {
  assert.equal(approachLabel('desk_roleplay'), 'Analyst desk role-play');
  assert.equal(approachLabel('desk_fresh_sessions'), 'New session per specialist');
  assert.equal(approachLabel('unknown'), 'unknown');
});

test('pct formats accuracy', () => {
  assert.equal(pct(3, 4), '75%');
  assert.equal(pct(0, 0), '—');
});

test('formatDurationMs uses minutes and seconds', () => {
  assert.equal(formatDurationMs(6 * 60_000), '6 min');
  assert.equal(formatDurationMs(45_000), '45s');
});

test('isChatDeskExperimentModel keeps Chat COPILOT_MODEL and drops gpt-4o-mini', () => {
  assert.equal(
    isChatDeskExperimentModel('deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4-flash-0731'),
    true,
  );
  assert.equal(
    isChatDeskExperimentModel('openai/gpt-4o-mini', 'deepseek/deepseek-v4-flash-0731'),
    false,
  );
  assert.equal(isChatDeskExperimentModel('openai/gpt-4o-mini'), false);
  assert.equal(isChatDeskExperimentModel('deepseek/deepseek-v4-flash-0731'), true);
});

const CASES = ['drift-breakdown', 'bolt-coil', 'cove-event', 'dune-duration'];
const APPROACHES = ['solo', 'desk_roleplay', 'desk_shared_session', 'desk_fresh_sessions'];

function cell(
  rep_id: string,
  question_id: string,
  opts: { status?: string; correct?: boolean; error?: string } = {},
): DeskRunForConclusion['results']['cells'][number] {
  return {
    rep_id,
    question_id,
    status: opts.status ?? 'done',
    correct: opts.correct ?? true,
    error: opts.error,
  };
}

function runWithCells(
  cells: DeskRunForConclusion['results']['cells'],
  extra: Partial<Pick<DeskRunForConclusion, 'id' | 'created_at' | 'model'>> = {},
): DeskRunForConclusion {
  return {
    id: extra.id ?? 'run-1',
    model: extra.model ?? 'deepseek/deepseek-v4-flash-0731',
    created_at: extra.created_at ?? 100,
    results: {
      design_id: 'desk-approaches-v2',
      questions: CASES.map((id) => ({ id })),
      rep_order: APPROACHES,
      cells,
    },
  };
}

function perfectMatrix(): DeskRunForConclusion['results']['cells'] {
  return APPROACHES.flatMap((rep) => CASES.map((q) => cell(rep, q)));
}

test('pickLatestChatDeskRun ignores gpt-4o-mini and keeps the newest Chat run', () => {
  const latest = pickLatestChatDeskRun([
    runWithCells(perfectMatrix(), { id: 'old', created_at: 1 }),
    runWithCells(perfectMatrix(), {
      id: 'gpt',
      created_at: 99,
      model: 'openai/gpt-4o-mini',
    }),
    runWithCells(perfectMatrix(), { id: 'new', created_at: 50 }),
  ]);
  assert.equal(latest?.id, 'new');
});

test('buildDeskApproachesConclusion waits for a published Chat run', () => {
  const conclusion = buildDeskApproachesConclusion(null);
  assert.match(conclusion.summary, /No published Chat-model run/);
  assert.match(conclusion.wrapUp, /Chat-model matrix/);
});

test('buildDeskApproachesConclusion reports a 16/16 tie as extra sessions not beating one voice', () => {
  const conclusion = buildDeskApproachesConclusion(runWithCells(perfectMatrix()));
  assert.equal(conclusion.cells_correct, 16);
  assert.equal(conclusion.cells_wrong, 0);
  assert.equal(conclusion.cells_aborted, 0);
  assert.equal(conclusion.winningApproaches.length, 4);
  assert.match(conclusion.summary, /16\/16/);
  assert.match(conclusion.wrapUp, /extra sessions did not beat one voice/);
});

test('buildDeskApproachesConclusion treats a fresh DUNE abort as operational, not a wrong lean', () => {
  const cells = perfectMatrix().map((row) => (
    row.rep_id === 'desk_fresh_sessions' && row.question_id === 'dune-duration'
      ? cell(row.rep_id, row.question_id, {
        status: 'error',
        correct: false,
        error: 'The operation was aborted due to timeout',
      })
      : row
  ));
  const conclusion = buildDeskApproachesConclusion(runWithCells(cells));
  assert.equal(conclusion.cells_correct, 15);
  assert.equal(conclusion.cells_done, 15);
  assert.equal(conclusion.cells_aborted, 1);
  assert.equal(conclusion.cells_wrong, 0);
  assert.match(conclusion.summary, /15\/15/);
  assert.match(conclusion.summary, /seat timeouts, not wrong leans/);
  assert.match(conclusion.wrapUp, /dune-duration/);
  assert.match(conclusion.wrapUp, /operational/);
});

test('buildDeskApproachesConclusion names a wrong finished lean', () => {
  const cells = perfectMatrix().map((row) => (
    row.rep_id === 'solo' && row.question_id === 'cove-event'
      ? cell(row.rep_id, row.question_id, { correct: false })
      : row
  ));
  const conclusion = buildDeskApproachesConclusion(runWithCells(cells));
  assert.equal(conclusion.cells_wrong, 1);
  assert.match(conclusion.wrapUp, /Solo analyst missed cove-event/);
  assert.ok(!conclusion.winningApproaches.includes('solo'));
});
