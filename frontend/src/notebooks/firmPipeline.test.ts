import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFirmPipelineConclusion,
  firmApproachLabel,
  firmSessionCountLabel,
  type DeskRunForConclusion,
} from './firmPipeline.ts';

test('firmApproachLabel names TradingAgents-style stages', () => {
  assert.equal(firmApproachLabel('solo'), 'Solo trader');
  assert.equal(firmApproachLabel('reports_then_trader'), 'Analyst reports → trader');
  assert.equal(firmApproachLabel('bull_bear_debate'), 'Bull vs bear research');
  assert.equal(firmApproachLabel('firm_risk_committee'), 'Full firm pipeline');
  assert.equal(firmApproachLabel('unknown'), 'unknown');
});

test('firmSessionCountLabel matches isolated-seat waves', () => {
  assert.equal(firmSessionCountLabel('one'), '1');
  assert.equal(firmSessionCountLabel('reports_then_trader'), '5');
  assert.equal(firmSessionCountLabel('bull_bear'), '7');
  assert.equal(firmSessionCountLabel('firm_pipeline'), '10');
});

const CASES = ['drift-breakdown', 'bolt-coil', 'cove-event', 'dune-duration'];
const APPROACHES = ['solo', 'reports_then_trader', 'bull_bear_debate', 'firm_risk_committee'];

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
): DeskRunForConclusion {
  return {
    id: 'run-1',
    model: 'deepseek/deepseek-v4-flash-0731',
    created_at: 100,
    results: {
      design_id: 'firm-pipeline-v1',
      questions: CASES.map((id) => ({ id })),
      rep_order: APPROACHES,
      cells,
    },
  };
}

function perfectMatrix(): DeskRunForConclusion['results']['cells'] {
  return APPROACHES.flatMap((rep) => CASES.map((q) => cell(rep, q)));
}

test('buildFirmPipelineConclusion waits for a published Chat run', () => {
  const conclusion = buildFirmPipelineConclusion(null);
  assert.match(conclusion.summary, /No published Chat-model run/);
  assert.match(conclusion.wrapUp, /bull\/bear/);
});

test('buildFirmPipelineConclusion reports a 16/16 tie as extra stages not beating solo', () => {
  const conclusion = buildFirmPipelineConclusion(runWithCells(perfectMatrix()));
  assert.equal(conclusion.cells_correct, 16);
  assert.equal(conclusion.winningApproaches.length, 4);
  assert.match(conclusion.wrapUp, /extra stages did not beat a solo take/);
  assert.match(conclusion.wrapUp, /does not/);
});

test('buildFirmPipelineConclusion names a debate win over reports-only', () => {
  const cells = perfectMatrix().map((row) => (
    row.rep_id === 'reports_then_trader' && row.question_id === 'cove-event'
      ? cell(row.rep_id, row.question_id, { correct: false })
      : row
  ));
  const conclusion = buildFirmPipelineConclusion(runWithCells(cells));
  assert.equal(conclusion.cells_wrong, 1);
  assert.match(conclusion.wrapUp, /Bull\/bear research beat reports-only/);
  assert.ok(!conclusion.winningApproaches.includes('reports_then_trader'));
});

test('buildFirmPipelineConclusion names a risk-committee win over stopping at the trader', () => {
  const cells = perfectMatrix().map((row) => (
    row.rep_id === 'bull_bear_debate' && row.question_id === 'cove-event'
      ? cell(row.rep_id, row.question_id, { correct: false })
      : row
  ));
  const conclusion = buildFirmPipelineConclusion(runWithCells(cells));
  assert.match(conclusion.wrapUp, /later risk committee improved the grade/);
});

test('buildFirmPipelineConclusion treats a seat-timeout error cell as an abort, not a wrong lean', () => {
  const cells = perfectMatrix().map((row) => (
    row.rep_id === 'bull_bear_debate' && row.question_id === 'bolt-coil'
      ? cell(row.rep_id, row.question_id, {
        status: 'error',
        correct: false,
        error: 'The operation was aborted due to timeout',
      })
      : row
  ));
  const conclusion = buildFirmPipelineConclusion(runWithCells(cells));
  assert.equal(conclusion.cells_aborted, 1);
  assert.equal(conclusion.cells_wrong, 0);
  assert.equal(conclusion.cells_correct, 15);
  assert.equal(conclusion.cells_done, 15);
  assert.match(conclusion.summary, /aborted/);
  assert.match(conclusion.wrapUp, /seat aborts/);
});
