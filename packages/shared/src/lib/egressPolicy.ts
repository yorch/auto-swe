import { z } from 'zod';

export const egressAllowlistSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .regex(
        /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
        'must be a valid hostname or wildcard hostname (e.g. registry.npmjs.org or *.github.com)'
      )
  )
  .max(100);

export const DEFAULT_EGRESS_BASELINE_ALLOWLIST = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'ghcr.io',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'plugins-artifacts.gradle.org',
  'services.gradle.org',
  'proxy.golang.org',
  'sum.golang.org',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'rubygems.org',
  'index.rubygems.org',
  'api.nuget.org',
  'globalcdn.nuget.org',
];

export function effectiveEgressAllowlist(
  policy: EgressPolicy,
  team: readonly string[],
  baseline: readonly string[]
): string[] {
  return policy === 'blocked' || (policy === 'open' && team.length === 0)
    ? []
    : [...new Set([...baseline, ...team].map((host) => host.toLowerCase()))];
}

/**
 * How much outbound network access a run's containers get, loosest first.
 *
 * - `open`: baseline union team when a team list exists, any public host otherwise.
 * - `restricted`: baseline union team is mandatory; an empty effective list reaches nothing.
 * - `blocked`: nothing but the platform's own proxies and the repository's git host.
 */
export const EGRESS_POLICIES = ['open', 'restricted', 'blocked'] as const;
export const egressPolicySchema = z.enum(EGRESS_POLICIES);
export type EgressPolicy = z.infer<typeof egressPolicySchema>;

export const setupEgressPolicySchema = z.enum(['inherit', 'open', 'restricted']);
export type SetupEgressPolicy = z.infer<typeof setupEgressPolicySchema>;

export function effectiveSetupEgressPolicy(
  agent: EgressPolicy,
  setup: SetupEgressPolicy,
  hasAllowlist = true
): EgressPolicy {
  if (setup === 'inherit' || (setup === 'restricted' && !hasAllowlist)) {
    return agent;
  }
  return RANK[setup] < RANK[agent] ? setup : agent;
}

const RANK: Record<EgressPolicy, number> = { blocked: 2, open: 0, restricted: 1 };

export const EGRESS_REPORT_MAX_AGE_MS = 30 * 60_000;

export interface WorkerEgressReport {
  id: string;
  backend: string;
  egressProxy: boolean;
  registryProxy: boolean;
  networkLock: boolean;
  detail: string;
  reportedAt: Date;
}

export function summarizeEgressCapabilities(reports: WorkerEgressReport[], now = new Date()) {
  const fresh = reports.filter(
    (r) => r.reportedAt.getTime() >= now.getTime() - EGRESS_REPORT_MAX_AGE_MS
  );
  const networkLock = fresh.length > 0 && fresh.every((r) => r.networkLock);
  const proxy = fresh.length > 0 && fresh.every((r) => r.egressProxy);
  const reasons = [
    ...new Set(
      fresh.flatMap((r) => [
        ...(!r.networkLock ? [`${r.id}: ${r.detail || 'network lock unavailable'}`] : []),
        ...(!r.egressProxy ? [`${r.id}: no egress proxy`] : []),
      ])
    ),
  ];
  return {
    detail:
      fresh.length === 0
        ? 'No worker has reported its egress capabilities yet.'
        : reasons.join('; '),
    enforceable: {
      blocked: networkLock,
      open: true,
      restricted: networkLock,
      restrictedAllowlist: networkLock && proxy,
    },
    reports: fresh,
  };
}

export type EgressCapabilitySummary = ReturnType<typeof summarizeEgressCapabilities>;

export function egressEnforcementWarnings(
  summary: EgressCapabilitySummary,
  policy: unknown,
  hasAllowlist: boolean
): string[] {
  if (summary.reports.length === 0 || policy === 'open') {
    return [];
  }
  const ok =
    policy === 'blocked'
      ? summary.enforceable.blocked
      : policy === 'restricted'
        ? hasAllowlist
          ? summary.enforceable.restrictedAllowlist
          : summary.enforceable.restricted
        : true;
  return ok
    ? []
    : [
        `${policy} cannot be enforced${hasAllowlist && policy === 'restricted' ? ' with a non-empty allowlist' : ''}: ${summary.detail}`,
      ];
}

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
