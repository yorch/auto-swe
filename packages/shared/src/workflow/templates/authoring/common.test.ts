import { describe, expect, it } from 'vitest';
import { NodeSchema } from '../../spec.js';
import {
  inGroup,
  initCounters,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
  terminate,
} from './common.js';

describe('initCounters', () => {
  it('initialises both retry counters and keeps the implementation, by default', () => {
    expect(initCounters('setReviewing')).toMatchObject({
      next: 'setReviewing',
      type: 'set',
      values: {
        'context.ciRetries': { literal: 0 },
        'context.currentCodeResult': { from: 'nodes.implement.output' },
        'context.reviewRetries': { literal: 0 },
      },
    });
  });

  it('only initialises the loops a template has', () => {
    const noCi = initCounters('n', { ci: false }) as { values: Record<string, unknown> };
    expect(Object.keys(noCi.values).sort()).toEqual([
      'context.currentCodeResult',
      'context.reviewRetries',
    ]);
    const noReview = initCounters('n', { review: false }) as { values: Record<string, unknown> };
    expect(Object.keys(noReview.values)).not.toContain('context.reviewRetries');
  });

  it('starts a template-specific counter at 0', () => {
    const node = initCounters('n', { counters: ['context.signoffRetries'] }) as {
      values: Record<string, unknown>;
    };
    expect(node.values['context.signoffRetries']).toEqual({ literal: 0 });
  });
});

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
