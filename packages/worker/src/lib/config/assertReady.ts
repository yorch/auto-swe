import { prisma } from '@auto-swe/shared/db';
import { parseProviderModelSpec } from '../providerUtils.js';
import { resolveAgent } from './agentResolver.js';
import { requiredAgentKeysForDeployment } from './deploymentAgents.js';

/// Walks every required Agent and confirms the worker has everything it needs
/// to run an activity. Throws a single error listing EVERY missing piece so the
/// operator doesn't have to fix them one at a time. Called at worker boot; if it
/// throws, the process exits non-zero with the message visible.
///
/// Checked invariants:
///   - Every agent key the *installed* templates can reach
///     (`requiredAgentKeysForDeployment()`) has an active GLOBAL `Agent` whose
///     model resolves — i.e. a `modelSpec` (or an `inheritsModelFrom` chain to
///     one) AND a `ProviderCredential` for that provider. `resolveAgent`
///     performs exactly this resolution, so we just run it and collect failures.
///   - The singleton `EmbeddingConfig` row exists, and its provider has a
///     resolvable GLOBAL credential.
export async function assertConfigReady(): Promise<void> {
  const missing: string[] = [];

  // Per-agent checks — the keys reachable from what this deployment has
  // installed, not the whole SWE step catalog. resolveAgent throws
  // ConfigMissingError when the Agent, its model, or its credential is absent;
  // collect the messages instead of failing on the first.
  for (const role of await requiredAgentKeysForDeployment()) {
    try {
      await resolveAgent(role);
    } catch (err) {
      missing.push(`  - Agent '${role}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Embedding config check (separate singleton; not an Agent).
  const embedding = await prisma.embeddingConfig.findUnique({
    include: { credential: { select: { provider: true } } },
    where: { id: 'default' },
  });
  if (!embedding) {
    missing.push('  - EmbeddingConfig row (system-wide embedding model)');
  } else {
    let embedProvider: string | null = null;
    try {
      embedProvider = parseProviderModelSpec(embedding.modelSpec).provider;
    } catch (err) {
      missing.push(
        `  - EmbeddingConfig has invalid modelSpec '${embedding.modelSpec}': ${err instanceof Error ? err.message : err}`
      );
    }
    if (embedProvider !== null) {
      if (embedding.credential) {
        if (embedding.credential.provider !== embedProvider) {
          missing.push(
            `  - EmbeddingConfig (spec '${embedding.modelSpec}', provider '${embedProvider}') pins a credential for a different provider '${embedding.credential.provider}'. Either unpin or pin a matching one.`
          );
        }
      } else {
        const cred = await prisma.providerCredential.findFirst({
          where: { provider: embedProvider, scope: 'GLOBAL' },
        });
        if (!cred) {
          missing.push(
            `  - GLOBAL ProviderCredential for provider '${embedProvider}' (needed by EmbeddingConfig)`
          );
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `LLM configuration incomplete. The worker cannot start until the following are resolvable:\n${missing.join('\n')}\n\n` +
        'The built-in agents are created by the DB seed; add the missing ProviderCredential(s) and the EmbeddingConfig at /admin/model-config, and any custom agents at /admin/agents/library. See docs/model-configuration.md.'
    );
  }
}
