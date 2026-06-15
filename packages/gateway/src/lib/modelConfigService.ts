import type { PrismaClient } from '@auto-swe/shared';

/**
 * EmbeddingConfig service (singleton upsert). The per-role ModelRoleConfig
 * service was retired in P1.5 — per-role model/prompt config now lives on the
 * first-class Agent entity (`agentLibraryService.ts`). Provider credentials are
 * handled by `credentialService.ts`. Audit-log writes stay with the routes.
 */

/// Upserts the singleton EmbeddingConfig row and returns both the prior and
/// the new state so the caller can write the audit entry.
export async function upsertEmbeddingConfig(
  prisma: PrismaClient,
  input: { actorId: string; credentialId: string | null; modelSpec: string }
) {
  const existing = await prisma.embeddingConfig.findUnique({ where: { id: 'default' } });
  const updated = await prisma.embeddingConfig.upsert({
    create: {
      credentialId: input.credentialId,
      id: 'default',
      modelSpec: input.modelSpec,
      updatedById: input.actorId,
    },
    update: {
      credentialId: input.credentialId,
      modelSpec: input.modelSpec,
      updatedById: input.actorId,
    },
    where: { id: 'default' },
  });
  return { existing, updated };
}
