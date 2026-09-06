import assert from 'node:assert/strict';
import test from 'node:test';
import { approachLabel, isChatDeskExperimentModel, pct } from './deskApproaches.ts';

test('approachLabel names production role-play vs fresh sessions', () => {
  assert.equal(approachLabel('desk_roleplay'), 'Analyst desk role-play');
  assert.equal(approachLabel('desk_fresh_sessions'), 'New session per specialist');
  assert.equal(approachLabel('unknown'), 'unknown');
});

test('pct formats accuracy', () => {
  assert.equal(pct(3, 4), '75%');
  assert.equal(pct(0, 0), '—');
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
