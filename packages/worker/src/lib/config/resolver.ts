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

  // Model spec + credential cascade: first non-null row wins. systemPrompt is
  // also cascaded independently within the same set of rows already fetched —
  // a row at a higher scope (e.g. WORKFLOW_TEMPLATE) may carry the model spec
  // but leave systemPrompt=null, allowing a lower-scope row to supply it.
  // To avoid extra DB calls, we only fetch a lower scope when it would have
  // been consulted for the spec anyway (i.e. no higher-scope row existed).
  // Once the spec row is found, we fetch the next scope only if the spec row
  // had systemPrompt=null AND that next scope has a reason to be queried
  // (team/global always exist in the cascade).

  type ScopeEntry = { row: ModelRoleConfigWithCredential; scope: 'WORKFLOW_TEMPLATE' | 'TEAM' | 'GLOBAL' };
  let specEntry: ScopeEntry | undefined;
  let systemPrompt: string | undefined;

  // Helper: check whether a row provides a systemPrompt value.
  const hasPrompt = (r: ModelRoleConfigWithCredential) => r.systemPrompt != null;
  // Helper: check whether a row explicitly has the systemPrompt column (i.e.
  // the DB returned it). A row where the property is absent (old mocks /
  // migrated code without the column) is treated the same as "no prompt set
  // at this scope — stop cascading." A row where the column exists but is
  // null triggers a cascade to the next scope.
  const hasSystemPromptColumn = (r: ModelRoleConfigWithCredential) => 'systemPrompt' in r;

  // Track whether we need to keep looking for a systemPrompt at lower scopes.
  // We cascade to the next scope only when the current row has the column but
  // its value is null (i.e. the operator deliberately left it unset at this
  // scope). When the field is absent from the row object (old mocks / code
  // predating the column), we treat it as "not set — stop cascading," so this
  // feature is backwards-compatible and does not cause extra DB calls.
  let needPromptCascade = false;

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
    if (row) {
      specEntry = { row, scope: 'WORKFLOW_TEMPLATE' };
      if (hasPrompt(row)) {
        systemPrompt = row.systemPrompt as string;
      } else {
        // Column present but null — cascade to lower scope for systemPrompt.
        needPromptCascade = hasSystemPromptColumn(row);
      }
    }
  }

  // 2. Team scope — fetch when we don't have a spec yet, or the spec row
  //    had systemPrompt=null (column exists, value null → cascade).
  if (ctx?.teamId && (!specEntry || needPromptCascade)) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: { role: prismaRole, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      if (!specEntry) specEntry = { row, scope: 'TEAM' };
      if (needPromptCascade || !specEntry) {
        if (hasPrompt(row)) {
          systemPrompt = row.systemPrompt as string;
          needPromptCascade = false;
        } else {
          needPromptCascade = hasSystemPromptColumn(row);
        }
      }
    }
  }

  // 3. Global scope — fetch when we don't have a spec yet, or systemPrompt
  //    cascade is still pending.
  if (!specEntry || needPromptCascade) {
    const globalRow = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: { role: prismaRole, scope: 'GLOBAL' },
    });
    if (globalRow) {
      if (!specEntry) specEntry = { row: globalRow, scope: 'GLOBAL' };
      if (needPromptCascade && hasPrompt(globalRow)) {
        systemPrompt = globalRow.systemPrompt as string;
      }
    }
  }

  if (!specEntry) {
    // No fallback. The worker's startup check should have refused to start
    // without a GLOBAL row for every role; reaching this branch means an
    // operator deleted it after boot.
    throw new ConfigMissingError(
      `No GLOBAL ModelRoleConfig row for role '${role}'. Restore it via the admin dashboard at /admin/model-config.`
    );
  }

  return materializeRow(specEntry.row, specEntry.scope, ctx, systemPrompt);
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
  const resolved = await withCache(cacheKey, configCacheTtlMs(), () =>
    resolveProviderCredentialUncached(provider, ctx)
  );
  // When a team-scoped request fell through to the GLOBAL row, we cached
  // the GLOBAL credential under the team's cache key. That would mask a
  // subsequent TEAM-scope insert for the full TTL — bust the cache now so
  // the next call re-queries and picks up the new row. (Same idea as the
  // ENV_FALLBACK invalidate in resolveModelConfig — don't pin a stale
  // fallback while an operator might be adding the row they expect to win.)
  if (ctx?.teamId && resolved._scope === 'GLOBAL') {
    invalidate(cacheKey);
  }
  return { apiBase: resolved.apiBase, apiKey: resolved.apiKey };
}

interface ResolvedCredentialInternal {
  apiKey: string;
  apiBase?: string;
  /// Which scope the row came from — used by the wrapper above to detect
  /// cross-scope GLOBAL fallback. Not exposed to callers.
  _scope: 'TEAM' | 'GLOBAL';
}

async function resolveProviderCredentialUncached(
  provider: string,
  ctx?: ResolveCtx
): Promise<ResolvedCredentialInternal> {
  if (ctx?.teamId) {
    const row = await prisma.providerCredential.findFirst({
      where: { provider, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      const decrypted = decryptRow(row);
      return { _scope: 'TEAM', apiBase: decrypted.apiBase, apiKey: decrypted.apiKey };
    }
  }
  const globalRow = await prisma.providerCredential.findFirst({
    where: { provider, scope: 'GLOBAL' },
  });
  if (globalRow) {
    const decrypted = decryptRow(globalRow);
    return { _scope: 'GLOBAL', apiBase: decrypted.apiBase, apiKey: decrypted.apiKey };
  }

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
  ctx: ResolveCtx | undefined,
  systemPrompt: string | undefined
): Promise<ResolvedModelConfig> {
  const spec = row.modelSpec;
  const { provider } = parseProviderModelSpec(spec);

  // Pinned credential on the row (template-scope override). If absent, cascade
  // through the provider's TEAM/GLOBAL credentials.
  if (row.credential) {
    const decrypted = decryptRow(row.credential);
    return { apiBase: decrypted.apiBase, apiKey: decrypted.apiKey, scope, spec, systemPrompt };
  }
  const cred = await resolveProviderCredential(provider, ctx);
  return { apiBase: cred.apiBase, apiKey: cred.apiKey, scope, spec, systemPrompt };
}

function decryptRow(row: ProviderCredentialRow): { apiBase?: string; apiKey: string } {
  let apiKey: string;
  try {
    apiKey = decryptSecret({
      authTag: row.apiKeyAuthTag,
      ciphertext: row.apiKeyCiphertext,
      keyVersion: row.keyVersion,
      nonce: row.apiKeyNonce,
    });
  } catch (err) {
    // Corrupt ciphertext, rotated CONFIG_ENCRYPTION_KEY, or keyVersion drift.
    // Surface as ConfigMissingError so the calling activity sees the same
    // "fix it in the dashboard" affordance as a missing row, and the OTel
    // span attribution still reports a config failure rather than a generic
    // SDK error. Include the credential id + lastFour so the operator can
    // find the row to delete/recreate.
    throw new ConfigMissingError(
      `Failed to decrypt ProviderCredential id=${row.id} (provider='${row.provider}', lastFour='${row.lastFour}'): ${err instanceof Error ? err.message : err}. Delete and re-create the credential via /admin/model-config.`
    );
  }
  return { apiBase: row.apiBase ?? undefined, apiKey };
}

/// Test-only helper. Forces the next call past the cache.
export { invalidate as _invalidateConfigCache };
