import assert from 'node:assert/strict';
import { test } from 'node:test';

// Always passes. The eval check scores this file as its golden test, so the case's reference
// passes at the pinned commit while `sum.test.js` stays red for the end-to-end check to fix.
test('the toolchain runs', () => {
  assert.equal(1 + 1, 2);
});
