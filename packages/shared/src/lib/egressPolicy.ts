import { z } from 'zod';

/**
 * How much outbound network access a run's containers get, loosest first.
 *
 * - `open`: today's behaviour — the team egress allowlist when one exists, any public host otherwise.
 * - `restricted`: the team allowlist is mandatory; an empty list reaches nothing.
 * - `blocked`: nothing but the platform's own proxies and the repository's git host.
 */
export const EGRESS_POLICIES = ['open', 'restricted', 'blocked'] as const;
export const egressPolicySchema = z.enum(EGRESS_POLICIES);
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

const RANK: Record<EgressPolicy, number> = { blocked: 2, open: 0, restricted: 1 };

/** The stricter of two policies. */
export function stricterEgressPolicy(a: EgressPolicy, b: EgressPolicy): EgressPolicy {
  return RANK[a] >= RANK[b] ? a : b;
}

/** True when `requested` is at least as strict as `ceiling` — a run may narrow, never widen. */
export function egressPolicyNarrows(ceiling: EgressPolicy, requested: EgressPolicy): boolean {
  return RANK[requested] >= RANK[ceiling];
}

/**
 * Narrows `ceiling` (the resolved cascade value) by a run's request. An absent request keeps the
 * ceiling; a request looser than the ceiling is refused rather than clamped, so the caller can
 * tell the launcher instead of silently running with a policy they did not choose.
 */
export function narrowEgressPolicy(
  ceiling: EgressPolicy,
  requested: EgressPolicy | undefined
): { ok: true; policy: EgressPolicy } | { ok: false; ceiling: EgressPolicy } {
  if (requested === undefined) {
    return { ok: true, policy: ceiling };
  }
  return egressPolicyNarrows(ceiling, requested)
    ? { ok: true, policy: requested }
    : { ceiling, ok: false };
}
