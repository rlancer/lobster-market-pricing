import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_ITERATIONS_MAX,
  DESK_FORCE_FAILURES_MAX,
  PORTFOLIO_FORCE_FAILURES_MAX,
  QUERY_FORCE_FAILURES_MAX,
  TRADES_FORCE_FAILURES_MAX,
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

test('keeps auto after a successful query until the desk gather window ends', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 2,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 1,
  });
  assert.equal(policy.toolChoice, 'auto');
});

test('forces publish_desk after the gather window when the desk is required', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 6,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 5,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'publish_desk' });
  assert.ok((policy.maxOutputTokens ?? 0) >= 2_048);
});

test('forces publish_desk near the end even if the gather window is open', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: AGENT_ITERATIONS_MAX - 4,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 0,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'publish_desk' });
});

test('returns to auto after an odd desk failure so the model can gather more', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 6,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 5,
    failedDeskCount: 1,
  });
  assert.equal(policy.toolChoice, 'auto');
});

test('stays on auto after DESK_FORCE_FAILURES_MAX so a voluntary desk can still land', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 6,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 5,
    failedDeskCount: DESK_FORCE_FAILURES_MAX,
  });
  assert.equal(policy.toolChoice, 'auto');
});

test('keeps auto after publish_desk when trades are not required', () => {
  // Timeline bots still need render_chart after the desk; penultimate seals.
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 3,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: true,
  });
  assert.equal(policy.toolChoice, 'auto');
  assert.equal(policy.activeTools, undefined);
});

test('seals bot desk turns on the penultimate step after publish_desk', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: AGENT_ITERATIONS_MAX - 2,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: true,
    requireTrades: false,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
});

test('forces suggest_trades after publish_desk when trades are required', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 3,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: true,
    requireTrades: true,
    tradesPublished: false,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'suggest_trades' });
});

test('seals with tools off after suggest_trades has been published', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 4,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: true,
    requireTrades: true,
    tradesPublished: true,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
});

test('stops forcing suggest_trades after TRADES_FORCE_FAILURES_MAX failures', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 5,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: true,
    requireTrades: true,
    tradesPublished: false,
    failedTradesCount: TRADES_FORCE_FAILURES_MAX,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
});

test('forces publish_desk for bot / timeline turns once the gather window ends', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 6,
    successfulQuery: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 5,
    requireTrades: false,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'publish_desk' });
});

test('keeps bot turns on auto after a chart so the takeaway can land in text', () => {
  // Regression: sealing on chartPublished alone left "(see reasoning)" bot shares
  // on prod (2026-08-22 nowlobster force triggers after #210).
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 3,
    successfulQuery: true,
    requireDesk: false,
    stepsAfterQuery: 2,
  });
  assert.equal(policy.toolChoice, 'auto');
});

test('seals bot turns on the penultimate step', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: AGENT_ITERATIONS_MAX - 2,
    successfulQuery: true,
    requireDesk: false,
    stepsAfterQuery: 1,
  });
  assert.equal(policy.toolChoice, 'none');
  assert.deepEqual(policy.activeTools, []);
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

test('forces get_portfolio before lake SQL when a portfolio is attached', () => {
  // Regression: share 1pQXi6YlgunqnHl5QCzgfsTgn — model knew to call
  // get_portfolio but the loop forced run_query (SELECT 1 ×3) instead.
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 0,
    requirePortfolio: true,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'get_portfolio' });
});

test('does not force run_query while an attached portfolio is still loading', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 1,
    requirePortfolio: true,
    failedPortfolioCount: 0,
  });
  assert.deepEqual(policy.toolChoice, { type: 'tool', toolName: 'get_portfolio' });
  assert.notDeepEqual(policy.toolChoice, { type: 'tool', toolName: 'run_query' });
});

test('treats a loaded portfolio as grounding evidence (desk gather auto)', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 1,
    requirePortfolio: true,
    portfolioLoaded: true,
    requireDesk: true,
    deskPublished: false,
    stepsAfterQuery: 0,
  });
  assert.equal(policy.toolChoice, 'auto');
});

test('seals after PORTFOLIO_FORCE_FAILURES_MAX so the model can explain', () => {
  const policy = nextCopilotStepPolicy({
    ...base,
    stepNumber: 2,
    requirePortfolio: true,
    failedPortfolioCount: PORTFOLIO_FORCE_FAILURES_MAX,
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
