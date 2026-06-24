import { describe, expect, it } from 'vitest';
import { type CanaryConfig, hashUnitInterval, shouldRouteToCanary } from './canary.js';

const cfg = (percent: number): CanaryConfig => ({
  agentKey: 'implementer',
  candidateVersion: 2,
  percent,
});

describe('hashUnitInterval', () => {
  it('is deterministic and within [0,1)', () => {
    const a = hashUnitInterval('x');
    expect(a).toBe(hashUnitInterval('x'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });
});

describe('shouldRouteToCanary', () => {
  it('never routes at 0% and always at 100%', () => {
    expect(shouldRouteToCanary('k', cfg(0))).toBe(false);
    expect(shouldRouteToCanary('k', cfg(1))).toBe(true);
  });

  it('is stable for the same key', () => {
    const a = shouldRouteToCanary('wr-123', cfg(0.5));
    expect(shouldRouteToCanary('wr-123', cfg(0.5))).toBe(a);
  });

  it('routes roughly the configured fraction over many keys', () => {
    let routed = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      if (shouldRouteToCanary(`wr-${i}`, cfg(0.25))) {
        routed += 1;
      }
    }
    const frac = routed / n;
    // Within a few points of 25% (deterministic hash, no RNG flakiness).
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.3);
  });
});
