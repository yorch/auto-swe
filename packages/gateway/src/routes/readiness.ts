import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../plugins/auth.js';

/**
 * `GET /api/v1/platform/readiness` — whether the platform has what a first run needs.
 *
 * Derived from real state, not a checklist a person ticks: every provider the active GLOBAL
 * agents (and the embedding model) are bound to must have a credential, GitHub must have a token
 * or an App, and at least one repository connection must exist. Each item carries the studio
 * page that fixes it, so the dashboard can link straight there.
 */

export interface ReadinessProvider {
  provider: string;
  /** Agent keys (and `embeddings`) that call this provider. */
  usedBy: string[];
  present: boolean;
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
    const { agents, credentials, embedding, connectionCount } = await runUnscoped(
      'setup readiness spans every team',
      ['Agent', 'Connection'],
      async () => {
        const [agents, credentials, embedding, connectionCount] = await Promise.all([
          fastify.prisma.agent.findMany({
            select: { credentialId: true, key: true, modelSpec: true },
            where: { isActive: true, modelSpec: { not: null }, scope: 'GLOBAL' },
          }),
          fastify.prisma.providerCredential.findMany({
            select: { id: true, provider: true },
            where: { scope: 'GLOBAL' },
          }),
          fastify.prisma.embeddingConfig.findUnique({ where: { id: 'default' } }),
          fastify.prisma.connection.count({ where: { isActive: true, type: 'git_repo' } }),
        ]);
        return { agents, connectionCount, credentials, embedding };
      }
    );

    const credentialProviders = new Set(credentials.map((c) => c.provider.toLowerCase()));
    const usedBy = new Map<string, Set<string>>();
    const uncovered = new Set<string>();
    for (const agent of agents) {
      const provider = providerOf(agent.modelSpec);
      if (!provider) {
        continue;
      }
      const users = usedBy.get(provider) ?? new Set<string>();
      users.add(agent.key);
      usedBy.set(provider, users);
      // An agent pinned to its own credential does not need a GLOBAL one.
      if (!agent.credentialId && !credentialProviders.has(provider)) {
        uncovered.add(provider);
      }
    }

    const embeddingProvider = providerOf(embedding?.modelSpec);
    let embeddingOk = false;
    if (embeddingProvider) {
      const users = usedBy.get(embeddingProvider) ?? new Set<string>();
      users.add('embeddings');
      usedBy.set(embeddingProvider, users);
      embeddingOk = Boolean(embedding?.credentialId) || credentialProviders.has(embeddingProvider);
      if (!embeddingOk) {
        uncovered.add(embeddingProvider);
      }
    }

    const providers: ReadinessProvider[] = [...usedBy.entries()]
      .map(([provider, users]) => ({
        present: !uncovered.has(provider),
        provider,
        usedBy: [...users].sort(),
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));

    const gh = await resolveGitHubConfig();
    const githubOk = Boolean(gh.token) || Boolean(gh.appId && gh.appPrivateKey);
    const missingProviders = providers.filter((p) => !p.present).map((p) => p.provider);

    const items: ReadinessItem[] = [
      {
        detail:
          missingProviders.length === 0
            ? 'Every provider your agents use has a credential.'
            : `No credential for ${missingProviders.join(', ')}. Agents that use it fail at their first model call.`,
        href: '/studio/models?tab=credentials',
        id: 'credentials',
        label: 'Model provider credentials',
        ok: missingProviders.length === 0,
      },
      {
        detail: !embeddingProvider
          ? 'No embedding model is chosen. Memory and lesson search cannot work without one.'
          : embeddingOk
            ? 'The embedding model has a credential.'
            : `The embedding model uses ${embeddingProvider}, which has no credential.`,
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

    return { data: { items, providers, ready: items.every((i) => i.ok) } };
  });
};
