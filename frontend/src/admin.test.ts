import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_EMAILS, isAdminEmail, isAdminNavPath, isExperimentsNavPath } from './admin.ts';

test('ADMIN_EMAILS includes the owner account', () => {
  assert.ok(ADMIN_EMAILS.includes('robert.lancer@gmail.com'));
});

test('isAdminEmail accepts the owner email case-insensitively', () => {
  assert.equal(isAdminEmail('robert.lancer@gmail.com'), true);
  assert.equal(isAdminEmail('Robert.Lancer@gmail.com'), true);
  assert.equal(isAdminEmail('  robert.lancer@gmail.com  '), true);
});

test('isAdminEmail rejects non-admins and empty input', () => {
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
  assert.equal(isAdminEmail(''), false);
  assert.equal(isAdminEmail('someone@example.com'), false);
  assert.equal(isAdminEmail('robert.lancer@example.com'), false);
});

test('isAdminNavPath covers the admin hub and tool routes', () => {
  assert.equal(isAdminNavPath('/admin'), true);
  assert.equal(isAdminNavPath('/bots'), true);
  assert.equal(isAdminNavPath('/users'), true);
  assert.equal(isAdminNavPath('/chats'), true);
  assert.equal(isAdminNavPath('/trades'), true);
  assert.equal(isAdminNavPath('/chat-capabilities'), true);
  assert.equal(isAdminNavPath('/brand'), true);
  assert.equal(isAdminNavPath('/admin/test-runs'), true);
  assert.equal(isAdminNavPath('/admin/quality-gate'), true);
  assert.equal(isAdminNavPath('/chat-capabilities/extra'), true);
  // Legacy /copilot bookmarks redirect; path itself is no longer an admin tool.
  assert.equal(isAdminNavPath('/copilot'), false);
  assert.equal(isAdminNavPath('/chat'), false);
  assert.equal(isAdminNavPath('/docs'), false);
  assert.equal(isAdminNavPath('/'), false);
});

test('isExperimentsNavPath covers experiments and legacy notebooks paths', () => {
  assert.equal(isExperimentsNavPath('/experiments'), true);
  assert.equal(isExperimentsNavPath('/experiments/text-vs-image'), true);
  assert.equal(isExperimentsNavPath('/experiments/desk-approaches'), true);
  assert.equal(isExperimentsNavPath('/notebooks'), true);
  assert.equal(isExperimentsNavPath('/notebooks/text-vs-image'), true);
  assert.equal(isExperimentsNavPath('/admin'), false);
  assert.equal(isExperimentsNavPath('/chat'), false);
});
