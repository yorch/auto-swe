import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sum } from '../src/sum.js';

test('sum adds its arguments', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-1, 1), 0);
});
