import { describe, expect, it } from 'vitest';
import { NodeSchema } from '../../spec.js';
import { inGroup, prResult, statusStamp, storeCodeResult, terminate } from './common.js';

describe('statusStamp', () => {
  it('is an updateDomainState step carrying the status and the next node', () => {
    expect(statusStamp('IMPLEMENTING', 'implement')).toMatchObject({
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    });
  });

  it('stamps a group and lets a caller override the default title', () => {
    expect(statusStamp('X', 'n', { group: 'g' })).toMatchObject({
      group: 'g',
      title: 'Set status: X',
    });
    expect(statusStamp('X', 'n', { title: 'Mine' })).toMatchObject({ title: 'Mine' });
  });

  it('is a real step node, not a new type', () => {
    expect(NodeSchema.safeParse(statusStamp('X', 'n', { group: 'g' })).success).toBe(true);
  });
});

describe('terminate', () => {
  it('omits `result` unless given, and keeps an explicit empty one', () => {
    expect('result' in terminate('FAILED')).toBe(false);
    expect(terminate('TIMED_OUT', { result: {} })).toMatchObject({ result: {} });
    expect(terminate('SUCCESS', { result: prResult() })).toMatchObject({
      result: { prNumber: { from: 'context.prNumber' }, prUrl: { from: 'context.prUrl' } },
    });
  });

  it('is a valid terminate node', () => {
    expect(NodeSchema.safeParse(terminate('FAILED', { group: 'g', title: 't' })).success).toBe(
      true
    );
  });
});

describe('prResult', () => {
  it('returns a fresh object each time', () => {
    expect(prResult()).not.toBe(prResult());
    expect(prResult()).toEqual(prResult());
  });
});

describe('storeCodeResult', () => {
  it('stores the implementer output, from `implement` unless told otherwise', () => {
    expect(storeCodeResult('lint')).toMatchObject({
      next: 'lint',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    });
    expect(storeCodeResult('lint', {}, 'impl2')).toMatchObject({
      values: { 'context.currentCodeResult': { from: 'nodes.impl2.output' } },
    });
  });
});

describe('inGroup', () => {
  it('stamps a group on nodes that have none and leaves the others alone', () => {
    const out = inGroup('implement', {
      a: { next: 'b', step: 'x', type: 'step' },
      b: { group: 'mine', status: 'SUCCESS', type: 'terminate' },
    });
    expect(out.a.group).toBe('implement');
    expect(out.b.group).toBe('mine');
  });

  it('does not mutate its input', () => {
    const input = { a: { next: 'b', step: 'x', type: 'step' } } as const;
    inGroup('g', input);
    expect('group' in input.a).toBe(false);
  });
});
