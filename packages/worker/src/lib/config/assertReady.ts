import { prisma } from '@auto-swe/shared/db';
import { parseProviderModelSpec } from '../providerUtils.js';
import { ALL_ROLES } from './types.js';

/// Walks every required GLOBAL config row and confirms the worker has
/// everything it needs to run an activity. Throws a single error listing
/// EVERY missing piece so the operator doesn't have to fix them one at a
/// time. Called at worker boot; if it throws, the process exits non-zero
/// with the message visible.
///
/// Checked invariants:
///   - One GLOBAL `ModelRoleConfig` row per AgentRole (all 6).
///   - For each role's `<provider>/...` spec, EITHER the row pins a
///     specific `credentialId`, OR a GLOBAL `ProviderCredential` exists
///     for that provider name.
///   - The singleton `EmbeddingConfig` row exists, and its provider has a
///     resolvable credential under the same rule.
export async function assertConfigReady(): Promise<void> {
  const missing: string[] = [];

  // Per-role checks
  for (const role of ALL_ROLES) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: { select: { provider: true } } },
      where: { role, scope: 'GLOBAL' },
    });
    if (!row) {
      missing.push(`  - GLOBAL ModelRoleConfig for role '${role}'`);
      continue;
    }
    let specProvider: string;
    try {
      specProvider = parseProviderModelSpec(row.modelSpec).provider;
    } catch (err) {
      missing.push(
        `  - ModelRoleConfig for '${role}' has invalid modelSpec '${row.modelSpec}': ${err instanceof Error ? err.message : err}`
      );
      continue;
    }
    if (row.credential) {
      // A pinned credential must match the spec's provider; otherwise the
      // worker uses the wrong API key at activity time and the request fails
      // with an opaque 401 from the upstream LLM.
      if (row.credential.provider !== specProvider) {
        missing.push(
          `  - ModelRoleConfig for '${role}' (spec '${row.modelSpec}', provider '${specProvider}') pins a credential for a different provider '${row.credential.provider}'. Either unpin or pin a matching one.`
        );
      }
      continue;
    }
    const cred = await prisma.providerCredential.findFirst({
      where: { provider: specProvider, scope: 'GLOBAL' },
    });
    if (!cred) {
      missing.push(
        `  - GLOBAL ProviderCredential for provider '${specProvider}' (needed by role '${role}')`
      );
    }
  }

  // Embedding config check
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
      `LLM configuration incomplete. The worker cannot start until the following rows exist in the database:\n${missing.join('\n')}\n\n` +
        'Bring up the gateway + web dashboard first, sign in as an admin, and add the missing rows at /admin/model-config. See docs/model-configuration.md for the bootstrap flow.'
    );
  }
}
