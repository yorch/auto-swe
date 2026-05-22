import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { parseProviderModelSpec } from '../providerUtils.js';
import { configCacheTtlMs, invalidate, withCache } from './cache.js';
import {
  type AgentRole,
  type ResolveCtx,
  type ResolvedModelConfig,
  ROLE_TO_PRISMA,
} from './types.js';

/// Thrown when a required configuration row is missing. The worker boot
/// `assertConfigReady()` check catches this before activities run; if
/// somebody deletes a row at runtime, the activity itself will throw.
export class ConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigMissingError';
  }
}

/// Resolves the model spec + credential for a role at the given scope.
/// Cascade: WORKFLOW_TEMPLATE → TEAM → GLOBAL. There is no env-var fallback;
/// the GLOBAL row is required and must be present before any activity runs
/// (enforced by `assertConfigReady()` at worker startup).
export async function resolveModelConfig(
  role: AgentRole,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  const cacheKey = `model:${role}:${ctx?.workflowTemplateId ?? ''}:${ctx?.teamId ?? ''}`;
  return withCache(cacheKey, configCacheTtlMs(), () => resolveModelConfigUncached(role, ctx));
}

async function resolveModelConfigUncached(
  role: AgentRole,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  const prismaRole = ROLE_TO_PRISMA[role];

  // 1. Workflow template scope
  if (ctx?.workflowTemplateId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: {
        role: prismaRole,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) return materializeRow(row, 'WORKFLOW_TEMPLATE', ctx);
  }

  // 2. Team scope
  if (ctx?.teamId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: { role: prismaRole, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) return materializeRow(row, 'TEAM', ctx);
  }

  // 3. Global scope
  const globalRow = await prisma.modelRoleConfig.findFirst({
    include: { credential: true },
    where: { role: prismaRole, scope: 'GLOBAL' },
  });
  if (globalRow) return materializeRow(globalRow, 'GLOBAL', ctx);

  // No fallback. The worker's startup check should have refused to start
  // without a GLOBAL row for every role; reaching this branch means an
  // operator deleted it after boot.
  throw new ConfigMissingError(
    `No GLOBAL ModelRoleConfig row for role '${role}'. Restore it via the admin dashboard at /admin/model-config.`
  );
}

/// Look up the credential for a provider at the given scope. Cascade is
/// TEAM → GLOBAL (templates intentionally don't have their own credentials —
/// they reference an existing one via `ModelRoleConfig.credentialId`).
/// Throws `ConfigMissingError` when no credential exists for the provider.
export async function resolveProviderCredential(
  provider: string,
  ctx?: ResolveCtx
): Promise<{ apiBase?: string; apiKey: string }> {
  const cacheKey = `cred:${provider}:${ctx?.teamId ?? ''}`;
  return withCache(cacheKey, configCacheTtlMs(), () =>
    resolveProviderCredentialUncached(provider, ctx)
  );
}

async function resolveProviderCredentialUncached(
  provider: string,
  ctx?: ResolveCtx
): Promise<{ apiBase?: string; apiKey: string }> {
  if (ctx?.teamId) {
    const row = await prisma.providerCredential.findFirst({
      where: { provider, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) return decryptRow(row);
  }
  const globalRow = await prisma.providerCredential.findFirst({
    where: { provider, scope: 'GLOBAL' },
  });
  if (globalRow) return decryptRow(globalRow);

  throw new ConfigMissingError(
    `No ProviderCredential for provider '${provider}'. Add one via the admin dashboard at /admin/model-config.`
  );
}

/// Embedding-model spec + credential. The system has exactly one embedding
/// role (semantic memory commit), backed by the singleton `EmbeddingConfig`
/// row. Output must be 1536-dim or `generateEmbedding` throws.
export interface ResolvedEmbeddingConfig {
  spec: string;
  apiKey: string;
  apiBase?: string;
}

export async function resolveEmbeddingConfig(): Promise<ResolvedEmbeddingConfig> {
  // No scope cascade — embedding is system-wide. Per-call DB hit is cheap
  // (single-row table), but cache it anyway so the embedding cache in
  // embeddings.ts can short-circuit when nothing changed.
  return withCache('embedding-config', configCacheTtlMs(), resolveEmbeddingConfigUncached);
}

async function resolveEmbeddingConfigUncached(): Promise<ResolvedEmbeddingConfig> {
  const row = await prisma.embeddingConfig.findUnique({
    include: { credential: true },
    where: { id: 'default' },
  });
  if (!row) {
    throw new ConfigMissingError(
      'No EmbeddingConfig row. Set the embedding model at /admin/model-config (Embeddings tab) before starting the worker.'
    );
  }

  // Pinned credential first; otherwise resolve by the provider parsed from
  // the spec. Embeddings have no team/template scope.
  let credSource: { apiKey: string; apiBase?: string };
  if (row.credential) {
    credSource = decryptRow(row.credential);
  } else {
    const { provider } = parseProviderModelSpec(row.modelSpec);
    credSource = await resolveProviderCredential(provider);
  }
  return { apiBase: credSource.apiBase, apiKey: credSource.apiKey, spec: row.modelSpec };
}

type ProviderCredentialRow = NonNullable<
  Awaited<ReturnType<typeof prisma.providerCredential.findFirst>>
>;
type ModelRoleConfigWithCredential = NonNullable<
  Awaited<ReturnType<typeof prisma.modelRoleConfig.findFirst>>
> & {
  credential: ProviderCredentialRow | null;
};

async function materializeRow(
  row: ModelRoleConfigWithCredential,
  scope: 'WORKFLOW_TEMPLATE' | 'TEAM' | 'GLOBAL',
  ctx: ResolveCtx | undefined
): Promise<ResolvedModelConfig> {
  const spec = row.modelSpec;
  const { provider } = parseProviderModelSpec(spec);

  // Pinned credential on the row (template-scope override). If absent, cascade
  // through the provider's TEAM/GLOBAL credentials.
  if (row.credential) {
    const decrypted = decryptRow(row.credential);
    return { apiBase: decrypted.apiBase, apiKey: decrypted.apiKey, scope, spec };
  }
  const cred = await resolveProviderCredential(provider, ctx);
  return { apiBase: cred.apiBase, apiKey: cred.apiKey, scope, spec };
}

function decryptRow(row: ProviderCredentialRow): { apiBase?: string; apiKey: string } {
  const apiKey = decryptSecret({
    authTag: row.apiKeyAuthTag,
    ciphertext: row.apiKeyCiphertext,
    keyVersion: row.keyVersion,
    nonce: row.apiKeyNonce,
  });
  return { apiBase: row.apiBase ?? undefined, apiKey };
}

/// Test-only helper. Forces the next call past the cache.
export { invalidate as _invalidateConfigCache };
