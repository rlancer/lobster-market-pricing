import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_ITERATIONS_MAX,
  QUERY_FORCE_FAILURES_MAX,
  nextCopilotStepPolicy,
} from '../src/copilot-loop.ts';

const base = {
  remainingTokens: 4_000,
  successfulQuery: false,
  failedQueryCount: 0,
  preferFilterFrame: false,
  toolRoundTokensMax: 2_048,
  finalTokenReserve: 1_024,
};

test('forces run_query until a query succeeds', () => {
  const policy = nextCopilotStepPolicy({ ...base, stepNumber: 0 });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'run_query' });
});

test('prefers filter_frame on step 0 when a named frame was requested', () => {
  const policy = nextCopilotStepPolicy({ ...base, stepNumber: 0, preferFilterFrame: true });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'filter_frame' });
});

test('switches to auto after a successful query', () => {
  const policy = nextCopilotStepPolicy({ ...base, stepNumber: 2, successfulQuery: true });
  assert.equal(policy.toolChoice, 'auto');
  assert.equal(policy.activeTools, undefined);
});

test('stops forcing tools after QUERY_FORCE_FAILURES_MAX failures', () => {
  // Regression: chat c7d67546… burned 9 forced run_query probes (SELECT 1 /
  // SELECT 'test' AS t) because toolChoice stayed forced until success.
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 3,
    failedQueryCount: QUERY_FORCE_FAILURES_MAX,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
});

test('last step always seals a prose answer with tools off', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: AGENT_ITERATIONS_MAX - 1,
    failedQueryCount: 0,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
});

test('exhausted token budget throws before another tool round', () => {
  assert.throws(
    () => nextCopilotStepPolicy({ ...base, stepNumber: 1, remainingTokens: 100 }),
    /output-token budget exhausted/,
  );
});
