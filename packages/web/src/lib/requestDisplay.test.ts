import { describe, expect, it } from 'vitest';
import { attentionReasons } from './requestDisplay';

describe('attentionReasons', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  it('names approval, with time left when a step has a deadline', () => {
    const [reason] = attentionReasons(
      {
        pendingStepCount: 1,
        pendingStepDeadline: '2026-06-01T02:00:00Z',
        status: 'RUNNING',
      },
      now
    );
    expect(reason.label).toMatch(/^Awaiting approval · .*left$/);
  });
  it('flags failures and pull requests waiting for review', () => {
    expect(attentionReasons({ pendingStepCount: 0, status: 'FAILED' }, now)[0].label).toBe(
      'Failed'
    );
    expect(
      attentionReasons({ needsMerge: true, pendingStepCount: 0, status: 'RUNNING' }, now)[0].label
    ).toBe('Needs review');
    expect(attentionReasons({ pendingStepCount: 0, status: 'RUNNING' }, now)).toEqual([]);
  });
});
