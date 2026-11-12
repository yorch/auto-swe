import { describe, expect, it } from 'vitest';
import {
  EGRESS_POLICIES,
  effectiveSetupEgressPolicy,
  egressEnforcementWarnings,
  egressPolicyNarrows,
  egressPolicySchema,
  narrowEgressPolicy,
  setupEgressPolicySchema,
  stricterEgressPolicy,
  summarizeEgressCapabilities,
  type WorkerEgressReport,
} from './egressPolicy.js';

describe('setup egress policy', () => {
  it.each([
    ['open', 'inherit', 'open'],
    ['open', 'open', 'open'],
    ['open', 'restricted', 'open'],
    ['restricted', 'inherit', 'restricted'],
    ['restricted', 'open', 'open'],
    ['restricted', 'restricted', 'restricted'],
    ['blocked', 'inherit', 'blocked'],
    ['blocked', 'open', 'open'],
    ['blocked', 'restricted', 'restricted'],
  ] as const)('%s agent with %s setup uses %s', (agent, setup, expected) => {
    expect(effectiveSetupEgressPolicy(agent, setup)).toBe(expected);
  });
  it('treats restricted setup without a team allowlist as equal to blocked', () => {
    expect(effectiveSetupEgressPolicy('blocked', 'restricted', false)).toBe('blocked');
  });
  it('accepts only the exact supported setup policy values', () => {
    for (const value of ['inherit', 'open', 'restricted']) {
      expect(setupEgressPolicySchema.parse(value)).toBe(value);
    }
    for (const value of ['', 'blocked', 'OPEN', null, false, 1]) {
      expect(setupEgressPolicySchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('worker egress capabilities', () => {
  const now = new Date('2026-11-11T00:00:00Z');
  const report: WorkerEgressReport = {
    backend: 'docker',
    detail: '',
    egressProxy: true,
    id: 'worker',
    networkLock: true,
    registryProxy: false,
    reportedAt: now,
  };
  it('requires every fresh worker, including a proxy only for a non-empty restricted allowlist', () => {
    const summary = summarizeEgressCapabilities(
      [report, { ...report, egressProxy: false, id: 'other' }],
      now
    );
    expect(summary.enforceable).toEqual({
      blocked: true,
      open: true,
      restricted: true,
      restrictedAllowlist: false,
    });
    expect(egressEnforcementWarnings(summary, 'restricted', false)).toEqual([]);
    expect(egressEnforcementWarnings(summary, 'blocked', true)).toEqual([]);
    expect(egressEnforcementWarnings(summary, 'restricted', true)[0]).toContain('no egress proxy');
  });
  it('reports failed locks and ignores stale workers', () => {
    const broken = { ...report, detail: 'iptables unavailable', networkLock: false };
    expect(summarizeEgressCapabilities([report, broken], now).enforceable.blocked).toBe(false);
    expect(
      egressEnforcementWarnings(summarizeEgressCapabilities([broken], now), 'blocked', false)[0]
    ).toContain('iptables unavailable');
    expect(
      summarizeEgressCapabilities(
        [report, { ...broken, reportedAt: new Date(now.getTime() - 31 * 60_000) }],
        now
      ).enforceable.restrictedAllowlist
    ).toBe(true);
  });
  it('keeps open enforceable and no reports advisory', () => {
    const summary = summarizeEgressCapabilities([], now);
    expect(summary.enforceable.open).toBe(true);
    expect(summary.enforceable.blocked).toBe(false);
    expect(egressEnforcementWarnings(summary, 'blocked', false)).toEqual([]);
    expect(summary.detail).toBe('No worker has reported its egress capabilities yet.');
  });
});

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
