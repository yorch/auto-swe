import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IdempotencyHeaderSchema,
  uuidFromIdempotencyKey,
  workflowIdFromIdempotencyKey,
} from './idempotency.js';

describe('workflowIdFromIdempotencyKey', () => {
  it('is deterministic — the same key always yields the same workflow ID', () => {
    const a = workflowIdFromIdempotencyKey('wf', 'abcd1234', 'order-42');
    const b = workflowIdFromIdempotencyKey('wf', 'abcd1234', 'order-42');
    expect(a).toBe(b);
    // Without this the unique index on ActiveWorkflow.temporalWorkflowId can
    // never fire and a retried trigger silently starts a second run.
  });

  it('separates keys by scope, so the same key on two templates does not collide', () => {
    expect(workflowIdFromIdempotencyKey('wf', 'aaaaaaaa', 'k')).not.toBe(
      workflowIdFromIdempotencyKey('wf', 'bbbbbbbb', 'k')
    );
  });

  it('separates the scope from the key so concatenations cannot alias', () => {
    // 'ab' + 'c' must not hash the same as 'a' + 'bc'.
    expect(workflowIdFromIdempotencyKey('wf', 'ab', 'c')).not.toBe(
      workflowIdFromIdempotencyKey('wf', 'a', 'bc')
    );
  });

  it('distinguishes different keys within one scope', () => {
    expect(workflowIdFromIdempotencyKey('wf', 'abcd1234', 'one')).not.toBe(
      workflowIdFromIdempotencyKey('wf', 'abcd1234', 'two')
    );
  });

  it('keeps arbitrary client input out of the workflow ID', () => {
    const id = workflowIdFromIdempotencyKey('wf', 'abcd1234', 'a key/with spaces & symbols\n');
    expect(id).toMatch(/^wf-abcd1234-[0-9a-f]{16}$/);
    expect(id).not.toContain(' ');
  });

  it('produces a bounded ID regardless of key length', () => {
    const id = workflowIdFromIdempotencyKey('wf', 'abcd1234', 'x'.repeat(1000));
    expect(id).toHaveLength('wf-abcd1234-'.length + 16);
  });

  it('carries the caller-supplied prefix', () => {
    expect(workflowIdFromIdempotencyKey('wh', 'abcd1234', 'k').startsWith('wh-')).toBe(true);
  });
});

describe('IdempotencyHeaderSchema', () => {
  it('accepts a request with no key — idempotency is opt-in', () => {
    const parsed = IdempotencyHeaderSchema.safeParse({ 'content-type': 'application/json' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a key at the length limit', () => {
    const parsed = IdempotencyHeaderSchema.safeParse({
      'idempotency-key': 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an over-long key rather than hashing it anyway', () => {
    const parsed = IdempotencyHeaderSchema.safeParse({
      'idempotency-key': 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty key, which would otherwise alias every caller onto one run', () => {
    expect(IdempotencyHeaderSchema.safeParse({ 'idempotency-key': '' }).success).toBe(false);
  });
});

describe('uuidFromIdempotencyKey', () => {
  const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a version-8 UUID, the same for the same scope and key', () => {
    const a = uuidFromIdempotencyKey('campaign:u1:t1', 'k');
    expect(a).toMatch(UUID_V8);
    expect(uuidFromIdempotencyKey('campaign:u1:t1', 'k')).toBe(a);
  });

  it('differs across scopes and keys, including a scope/key boundary shift', () => {
    const a = uuidFromIdempotencyKey('campaign:u1:t1', 'k');
    expect(uuidFromIdempotencyKey('campaign:u2:t1', 'k')).not.toBe(a);
    expect(uuidFromIdempotencyKey('campaign:u1:t1', 'k2')).not.toBe(a);
    expect(uuidFromIdempotencyKey('ab', 'c')).not.toBe(uuidFromIdempotencyKey('a', 'bc'));
  });
});
