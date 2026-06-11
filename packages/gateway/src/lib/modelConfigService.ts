import type { PrismaClient } from '@auto-swe/shared';
import { isUniqueConstraintError } from './prismaErrors.js';

/**
 * ModelRoleConfig + EmbeddingConfig service. Holds the scope-keyed upsert
 * (with its P2002 race recovery), the effective-config cascade preview, and
 * the one-click defaults seeding. Shared by the admin routes
 * (`/api/v1/admin/model-config`) and the team-scoped routes
 * (`/api/v1/teams/:id/model-config`) — both call the same functions, only
 * the scope key differs. Audit-log writes stay with the routes.
 */

export const MODEL_AGENT_ROLES = [
  'IMPLEMENTER',
  'REVIEWER',
  'PLANNER',
  'SECURITY_REVIEW',
  'VALIDATE_CONTEXT',
  'COMMIT_TO_MEMORY',
] as const;
export const MODEL_CONFIG_SCOPES = ['GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE'] as const;

export type ModelAgentRole = (typeof MODEL_AGENT_ROLES)[number];
export type ModelConfigScope = (typeof MODEL_CONFIG_SCOPES)[number];

export type ModelRoleConfigRow = NonNullable<
  Awaited<ReturnType<PrismaClient['modelRoleConfig']['findFirst']>>
>;

/// Per-role baked-in defaults used by the "Seed defaults" button.
const DEFAULT_ROLE_SPECS: Record<ModelAgentRole, string> = {
  COMMIT_TO_MEMORY: 'anthropic/claude-opus-4-7',
  IMPLEMENTER: 'anthropic/claude-opus-4-7',
  PLANNER: 'anthropic/claude-sonnet-4-6',
  REVIEWER: 'anthropic/claude-opus-4-7',
  SECURITY_REVIEW: 'anthropic/claude-sonnet-4-6',
  VALIDATE_CONTEXT: 'anthropic/claude-sonnet-4-6',
};

const DEFAULT_EMBEDDING_SPEC = 'openai/text-embedding-3-large';

const CREDENTIAL_SUMMARY_INCLUDE = {
  credential: { select: { id: true, lastFour: true, provider: true } },
} as const;

export type ModelRoleConfigUpsertInput = {
  actorId: string;
  role: ModelAgentRole;
  scope: ModelConfigScope;
  teamId: string | null;
  workflowTemplateId: string | null;
  modelSpec: string;
  credentialId: string | null;
  systemPrompt: string | null;
};

export type ModelRoleConfigUpsertResult =
  | { action: 'CREATE'; before: undefined; row: ModelRoleConfigRow }
  | { action: 'UPDATE'; before: ModelRoleConfigRow; row: ModelRoleConfigRow };

/// findFirst → create-or-update, with one P2002 retry to handle the rare case
/// where two admins (or admin + team owner) write the same scope key at once.
/// The unique constraint in the migration prevents duplicate rows; this just
/// gracefully recovers from the race instead of surfacing a 500.
export async function upsertModelRoleConfig(
  prisma: PrismaClient,
  input: ModelRoleConfigUpsertInput
): Promise<ModelRoleConfigUpsertResult> {
  const scopeKey = {
    role: input.role,
    scope: input.scope,
    teamId: input.teamId,
    workflowTemplateId: input.workflowTemplateId,
  };
  const updateData = {
    credentialId: input.credentialId,
    modelSpec: input.modelSpec,
    systemPrompt: input.systemPrompt,
  };

  const existing = await prisma.modelRoleConfig.findFirst({ where: scopeKey });
  if (existing) {
    const updated = await prisma.modelRoleConfig.update({
      data: updateData,
      where: { id: existing.id },
    });
    return { action: 'UPDATE', before: existing, row: updated };
  }
  try {
    const created = await prisma.modelRoleConfig.create({
      data: { ...scopeKey, ...updateData, createdById: input.actorId },
    });
    return { action: 'CREATE', before: undefined, row: created };
  } catch (err) {
    if (!isUniqueConstraintError(err)) {
      throw err;
    }
    // Lost the create race — the row now exists. Update it.
    const row = await prisma.modelRoleConfig.findFirst({ where: scopeKey });
    if (!row) {
      throw err; // race recovery failed — surface the original
    }
    const updated = await prisma.modelRoleConfig.update({
      data: updateData,
      where: { id: row.id },
    });
    return { action: 'UPDATE', before: row, row: updated };
  }
}

/// Walks the WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade and returns the row
/// that would win for `(role, teamId?, workflowTemplateId?)`. Lets the UI
/// preview the cascade without users having to mentally re-run the resolver.
export async function getEffectiveModelConfig(
  prisma: PrismaClient,
  args: { role: ModelAgentRole; teamId?: string; workflowTemplateId?: string }
): Promise<{ row: unknown; scope: ModelConfigScope | null }> {
  const { role, teamId, workflowTemplateId } = args;
  if (workflowTemplateId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: CREDENTIAL_SUMMARY_INCLUDE,
      where: { role, scope: 'WORKFLOW_TEMPLATE', workflowTemplateId },
    });
    if (row) {
      return { row, scope: 'WORKFLOW_TEMPLATE' };
    }
  }
  if (teamId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: CREDENTIAL_SUMMARY_INCLUDE,
      where: { role, scope: 'TEAM', teamId },
    });
    if (row) {
      return { row, scope: 'TEAM' };
    }
  }
  const row = await prisma.modelRoleConfig.findFirst({
    include: CREDENTIAL_SUMMARY_INCLUDE,
    where: { role, scope: 'GLOBAL' },
  });
  if (row) {
    return { row, scope: 'GLOBAL' };
  }
  return { row: null, scope: null };
}

/// One-click admin bootstrap: inserts a GLOBAL ModelRoleConfig row for each
/// of the 6 roles using the baked-in defaults, plus the EmbeddingConfig
/// singleton if missing. Idempotent — skips roles that already have a
/// GLOBAL row. Does NOT seed credentials; those must be added separately
/// because they require a real API key from the operator. `onRoleSeeded`
/// runs after each successful insert so the caller can audit-log it.
export async function seedDefaultModelConfigs(
  prisma: PrismaClient,
  actorId: string,
  onRoleSeeded: (created: ModelRoleConfigRow) => Promise<void>
): Promise<{ embeddingSeeded: boolean; rolesSeeded: number }> {
  let rolesSeeded = 0;
  for (const [role, spec] of Object.entries(DEFAULT_ROLE_SPECS)) {
    const existing = await prisma.modelRoleConfig.findFirst({
      where: { role: role as ModelAgentRole, scope: 'GLOBAL' },
    });
    if (existing) {
      continue;
    }
    // Two admins double-clicking the button race on the count-then-create;
    // the partial unique index on (role) WHERE scope='GLOBAL' makes the
    // second insert fail. Swallow it — the first writer wins.
    try {
      const created = await prisma.modelRoleConfig.create({
        data: {
          createdById: actorId,
          modelSpec: spec,
          role: role as ModelAgentRole,
          scope: 'GLOBAL',
        },
      });
      await onRoleSeeded(created);
      rolesSeeded += 1;
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
    }
  }

  let embeddingSeeded = false;
  const existingEmbedding = await prisma.embeddingConfig.findUnique({
    where: { id: 'default' },
  });
  if (!existingEmbedding) {
    try {
      await prisma.embeddingConfig.create({
        data: { id: 'default', modelSpec: DEFAULT_EMBEDDING_SPEC, updatedById: actorId },
      });
      embeddingSeeded = true;
    } catch (err) {
      // Same race — id='default' is the singleton primary key, so a
      // concurrent insert produces P2002. Treat as "already seeded".
      if (!isUniqueConstraintError(err)) {
        throw err;
      }
    }
  }

  return { embeddingSeeded, rolesSeeded };
}

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
