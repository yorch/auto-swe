import { describe, expect, it } from 'vitest';
import { NodeSchema } from '../../spec.js';
import { inGroup, prResult, qualityGate, terminate } from './common.js';

describe('qualityGate', () => {
  it('is a warn-mode step: a failure is recorded and the run goes on', () => {
    expect(qualityGate('runLint', 'runTypecheck', { group: 'verify' })).toMatchObject({
      group: 'verify',
      next: 'runTypecheck',
      onFail: 'warn',
      step: 'runLint',
      title: 'Lint',
      type: 'step',
    });
  });

  it('titles an unknown gate from its step name', () => {
    expect(qualityGate('runMutation', 'n').title).toBe('Run runMutation');
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
