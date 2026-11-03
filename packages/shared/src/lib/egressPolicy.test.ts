import { describe, expect, it } from 'vitest';
import {
  EGRESS_POLICIES,
  egressPolicyNarrows,
  egressPolicySchema,
  narrowEgressPolicy,
  stricterEgressPolicy,
} from './egressPolicy.js';

describe('egressPolicySchema', () => {
  it('accepts exactly the three levels', () => {
    for (const level of EGRESS_POLICIES) {
      expect(egressPolicySchema.safeParse(level).success).toBe(true);
    }
    expect(egressPolicySchema.safeParse('closed').success).toBe(false);
  });
});

describe('stricterEgressPolicy', () => {
  it('returns the stricter of two levels in either order', () => {
    expect(stricterEgressPolicy('open', 'restricted')).toBe('restricted');
    expect(stricterEgressPolicy('blocked', 'restricted')).toBe('blocked');
    expect(stricterEgressPolicy('open', 'open')).toBe('open');
  });
});

describe('egressPolicyNarrows', () => {
  it('is true for the same or a stricter level, false for a looser one', () => {
    expect(egressPolicyNarrows('restricted', 'restricted')).toBe(true);
    expect(egressPolicyNarrows('open', 'blocked')).toBe(true);
    expect(egressPolicyNarrows('restricted', 'open')).toBe(false);
    expect(egressPolicyNarrows('blocked', 'restricted')).toBe(false);
  });
});

describe('narrowEgressPolicy', () => {
  it('keeps the ceiling when nothing is requested', () => {
    expect(narrowEgressPolicy('restricted', undefined)).toEqual({ ok: true, policy: 'restricted' });
  });

  it('takes a stricter request', () => {
    expect(narrowEgressPolicy('open', 'blocked')).toEqual({ ok: true, policy: 'blocked' });
  });

  it('refuses a looser request and names the ceiling', () => {
    expect(narrowEgressPolicy('blocked', 'open')).toEqual({ ceiling: 'blocked', ok: false });
  });
});
