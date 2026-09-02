import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentsForBody,
  hasPortfolioSource,
  isFinishIncompletePrompt,
  isIncompleteAssistantTurn,
  portfolioAttachmentsFromTools,
  removePortfolioAttachment,
  togglePortfolioAttachment,
  FINISH_INCOMPLETE_PROMPT,
} from './chatAttachments.ts';

test('togglePortfolioAttachment adds and removes by source', () => {
  const withSchwab = togglePortfolioAttachment([], 'schwab');
  assert.deepEqual(withSchwab, [{ kind: 'portfolio', source: 'schwab' }]);
  assert.equal(hasPortfolioSource(withSchwab, 'schwab'), true);
  assert.deepEqual(togglePortfolioAttachment(withSchwab, 'schwab'), []);
});

test('removePortfolioAttachment leaves other sources', () => {
  const both = [
    { kind: 'portfolio' as const, source: 'schwab' as const },
    { kind: 'portfolio' as const, source: 'paper' as const },
  ];
  assert.deepEqual(removePortfolioAttachment(both, 'schwab'), [
    { kind: 'portfolio', source: 'paper' },
  ]);
});

test('attachmentsForBody serializes handles only', () => {
  assert.deepEqual(
    attachmentsForBody([
      { kind: 'portfolio', source: 'schwab', account_id: 'acct' },
      { kind: 'portfolio', source: 'paper' },
    ]),
    [
      { kind: 'portfolio', source: 'schwab', account_id: 'acct' },
      { kind: 'portfolio', source: 'paper' },
    ],
  );
});

test('isIncompleteAssistantTurn detects tools without prose', () => {
  assert.equal(
    isIncompleteAssistantTurn({
      role: 'assistant',
      content: '',
      tools: [{ name: 'get_portfolio' }],
      reasoning: 'looking…',
    }),
    true,
  );
  assert.equal(
    isIncompleteAssistantTurn({
      role: 'assistant',
      content: 'Here are the risks…',
      tools: [{ name: 'get_portfolio' }],
    }),
    false,
  );
});

test('portfolioAttachmentsFromTools recovers schwab from args JSON', () => {
  assert.deepEqual(
    portfolioAttachmentsFromTools([
      { name: 'get_portfolio', args: '{"source":"schwab","status":"open"}', ok: true, summary: 'Schwab portfolio' },
      { name: 'research_ticker', args: 'SIVR', ok: true },
    ]),
    [{ kind: 'portfolio', source: 'schwab' }],
  );
});

test('isFinishIncompletePrompt matches finish follow-ups', () => {
  assert.equal(isFinishIncompletePrompt(FINISH_INCOMPLETE_PROMPT), true);
  assert.equal(isFinishIncompletePrompt('Finish the portfolio risk review you started — old copy'), true);
  assert.equal(isFinishIncompletePrompt('Any risks you see in my portfolio?'), false);
});
