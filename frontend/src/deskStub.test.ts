import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeskStubText } from './deskStub.ts';

test('isDeskStubText treats blocked-null sanitizer tokens as stubs', () => {
  assert.equal(isDeskStubText('REPLACE_WITH_NULL_VALUE_BLOCKED_INVALID:'), true);
  assert.equal(isDeskStubText('placeholder'), true);
  assert.equal(isDeskStubText('Mild-bullish: ride the 310/320 bull call into the weekly.'), false);
});
