/**
 * Production canary routing decision — P2 of the evals feature
 * (docs/evals-p2.md WS5, RFC §4.5). Pure, unit-tested.
 *
 * Routes a deterministic fraction of production runs to a candidate agent
 * version so a change can be A/B'd against control on *live, current* traffic
 * (no replay). Determinism (hash of a stable key, not RNG) means the same run
 * always lands in the same arm — stable across retries and reproducible.
 *
 * The routing *integration* (consulting this from work-request routing /
 * resolveAgent to pin the candidate version, and tagging the run as `canary`)
 * is the remaining wiring; this module owns the decision so it's testable.
 */

export interface CanaryConfig {
  /** Agent key under canary, e.g. 'implementer'. */
  agentKey: string;
  /** Candidate agent version to route the sampled fraction to. */
  candidateVersion: number;
  /** Fraction of runs to route to the candidate, in [0,1]. */
  percent: number;
}

/** FNV-1a 32-bit hash → a stable [0,1) bucket for a key. */
export function hashUnitInterval(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to unsigned, then normalize to [0,1).
  return (h >>> 0) / 0x100000000;
}

/**
 * Decide whether a run (identified by a stable key, e.g. the work-request id)
 * routes to the canary candidate. `percent <= 0` → never; `>= 1` → always.
 */
export function shouldRouteToCanary(key: string, config: CanaryConfig): boolean {
  if (config.percent <= 0) {
    return false;
  }
  if (config.percent >= 1) {
    return true;
  }
  return hashUnitInterval(`${config.agentKey}:${key}`) < config.percent;
}
