import {
  type CoverageGap,
  credentialGaps,
  loadCoverageInput,
} from '@auto-swe/shared/lib/credentialCoverage';
import { deploymentAgentRequirements } from '@auto-swe/shared/lib/deploymentAgents';
import { SEED_PLACEHOLDER_REPO } from '@auto-swe/shared/lib/seedPlaceholder';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';

/**
 * `GET /api/v1/platform/readiness` — whether the platform has what a first run needs.
 *
 * Derived from real state, not a checklist a person ticks: every agent the worker's boot gate
 * resolves (`deploymentAgentRequirements`) and the embedding model must have a credential it can
 * use — judged by `credentialGaps`, the same rules the credential delete guard applies — GitHub
 * must have a token or an App, and at least one real repository connection must exist (the
 * seeded sample repository does not count). Gaps outside the boot gate (agents no installed
 * template runs, team and organization overrides) are returned in `gaps` without failing
 * readiness. Each item carries the studio page that fixes it.
 */

export interface ReadinessProvider {
  provider: string;
  /** Agent keys (and `embeddings`) that call this provider. */
  usedBy: string[];
  /** False when one of those is left without a credential it can use. */
  present: boolean;
  /** Whether a caller the worker needs at boot (or the embedding model) uses it. */
  required: boolean;
}

export interface ReadinessItem {
  id: 'credentials' | 'embeddings' | 'github' | 'connections';
  label: string;
  ok: boolean;
  detail: string;
  href: string;
}

function providerOf(spec: string | null | undefined): string | null {
  const provider = spec?.split('/')[0]?.trim().toLowerCase();
  return provider ? provider : null;
}

export const readinessRoutes: FastifyPluginAsync = async (fastify) => {
  const adminOnly = requireAuth({ requiredRole: 'ADMIN' });

  fastify.get('/readiness', { onRequest: adminOnly }, async () => {
    const [coverage, required, connectionCount] = await Promise.all([
      loadCoverageInput(fastify.prisma),
      deploymentAgentRequirements(fastify.prisma),
      runUnscoped('setup readiness spans every team', ['Connection'], () =>
        fastify.prisma.connection.count({
          // The seeded sample repository is a placeholder, so it never satisfies this item.
          where: { isActive: true, NOT: { ...SEED_PLACEHOLDER_REPO }, type: 'git_repo' },
        })
      ),
    ]);

    // The same agents the worker's boot gate resolves, under the same coverage rules: a gap
    // there keeps the worker from starting, so it is what fails readiness. Every other gap —
    // an agent no installed template runs, a team or organization override — is reported, not
    // failed on, because the worker starts without it.
    const requiredKeys = new Set(required.keys);
    const gaps = credentialGaps(coverage);
    const globalAgents = coverage.agents.filter((a) => a.scope === 'GLOBAL');
    const globalKeys = new Set(globalAgents.map((a) => a.key));
    const isBlocking = (gap: CoverageGap) =>
      gap.subject !== 'embeddings' && gap.scope === 'GLOBAL' && requiredKeys.has(gap.subject);
    const blocking = gaps.filter(isBlocking);
    const missingAgents = [...requiredKeys].filter((key) => !globalKeys.has(key)).sort();
    const embeddingGap = gaps.find((g) => g.subject === 'embeddings') ?? null;

    // Per provider, which GLOBAL agents (and the embedding model) call it, and whether any of
    // them is left without a usable credential.
    const usedBy = new Map<string, Set<string>>();
    const uncovered = new Set<string>();
    for (const agent of globalAgents) {
      const provider = providerOf(agent.modelSpec);
      if (provider) {
        usedBy.set(provider, (usedBy.get(provider) ?? new Set()).add(agent.key));
      }
    }
    const embeddingProvider = providerOf(coverage.embedding?.modelSpec);
    if (embeddingProvider) {
      usedBy.set(embeddingProvider, (usedBy.get(embeddingProvider) ?? new Set()).add('embeddings'));
    }
    for (const gap of gaps) {
      if (gap.scope === 'GLOBAL' && gap.provider && usedBy.has(gap.provider)) {
        uncovered.add(gap.provider);
      }
    }
    const providers: ReadinessProvider[] = [...usedBy.entries()]
      .map(([provider, users]) => ({
        present: !uncovered.has(provider),
        provider,
        required: [...users].some((u) => u === 'embeddings' || requiredKeys.has(u)),
        usedBy: [...users].sort(),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
    const credentialsOk = blocking.length === 0 && missingAgents.length === 0;
    const embeddingOk = embeddingGap === null;

    const gh = await resolveGitHubConfig();
    const githubOk = Boolean(gh.token) || Boolean(gh.appId && gh.appPrivateKey);

    const items: ReadinessItem[] = [
      {
        detail: credentialsOk
          ? 'Every agent this deployment runs has a credential it can use.'
          : [
              ...(blocking.length > 0
                ? [
                    `No usable credential for ${blocking.map((g) => (g.provider ? `${g.subject} (${g.provider})` : g.subject)).join(', ')}. The worker does not start until these are fixed.`,
                  ]
                : []),
              ...(missingAgents.length > 0
                ? [`No platform-wide agent for ${missingAgents.join(', ')}.`]
                : []),
            ].join(' '),
        href: '/studio/models?tab=credentials',
        id: 'credentials',
        label: 'Model provider credentials',
        ok: credentialsOk,
      },
      {
        detail: embeddingOk
          ? 'The embedding model has a credential.'
          : embeddingGap?.problem === 'no-embedding-config'
            ? 'No embedding model is chosen. Memory and lesson search cannot work without one.'
            : (embeddingGap?.detail ?? ''),
        href: '/studio/models?tab=embeddings',
        id: 'embeddings',
        label: 'Embedding model',
        ok: embeddingOk,
      },
      {
        detail: githubOk
          ? 'GitHub access is configured.'
          : 'Add a personal access token or a GitHub App so runs can clone and open pull requests.',
        href: '/studio/integrations?tab=github',
        id: 'github',
        label: 'GitHub access',
        ok: githubOk,
      },
      {
        detail:
          connectionCount > 0
            ? `${connectionCount} ${connectionCount === 1 ? 'repository is' : 'repositories are'} connected.`
            : 'Connect at least one repository so work has somewhere to run.',
        href: '/connections',
        id: 'connections',
        label: 'Repository connection',
        ok: connectionCount > 0,
      },
    ];

    return {
      data: {
        // Every gap, the ones that fail readiness flagged, so a page can show what is advisory.
        gaps: gaps.map((gap) => ({
          ...gap,
          blocking: isBlocking(gap) || gap.subject === 'embeddings',
        })),
        items,
        providers,
        ready: items.every((i) => i.ok),
      },
    };
  });
};
