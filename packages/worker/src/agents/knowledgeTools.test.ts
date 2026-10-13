import { describe, expect, it } from 'vitest';
import {
  SEARCH_KNOWLEDGE_INPUT_SCHEMA,
  SEARCH_KNOWLEDGE_OUTPUT_SCHEMA,
  SUBMIT_LEARNING_INPUT_SCHEMA,
  SUBMIT_LEARNING_OUTPUT_SCHEMA,
} from './knowledgeTools.js';

describe('knowledge agent tool schemas', () => {
  it('bounds search input and returns a structured trust-labeled projection', () => {
    expect(SEARCH_KNOWLEDGE_INPUT_SCHEMA.safeParse({ query: 'test' }).success).toBe(true);
    expect(SEARCH_KNOWLEDGE_INPUT_SCHEMA.safeParse({ query: '' }).success).toBe(false);
    expect(SEARCH_KNOWLEDGE_OUTPUT_SCHEMA.safeParse({ mode: 'text', results: [] }).success).toBe(
      true
    );
  });

  it('requires evidence and idempotency for a local learning submission', () => {
    expect(
      SUBMIT_LEARNING_INPUT_SCHEMA.safeParse({
        content: 'A sufficiently substantive learning for validation.',
        evidence: [{ kind: 'node', reference: 'tests' }],
        idempotencyKey: 'retry-key-1',
        nodeId: 'tests',
        title: 'Verified test finding',
      }).success
    ).toBe(true);
    expect(
      SUBMIT_LEARNING_INPUT_SCHEMA.safeParse({
        content: 'A sufficiently substantive learning for validation.',
        evidence: [],
        idempotencyKey: 'retry-key-1',
        nodeId: 'tests',
        title: 'Verified test finding',
      }).success
    ).toBe(false);
    expect(
      SUBMIT_LEARNING_OUTPUT_SCHEMA.safeParse({ id: 'item-1', status: 'UNREVIEWED', version: 1 })
        .success
    ).toBe(true);
  });
});
