import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachmentsForBody,
  hasPortfolioSource,
  removePortfolioAttachment,
  togglePortfolioAttachment,
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
