import { configCacheTtlMs, invalidate, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { parseProviderModelSpec } from '../providerUtils.js';
import type { ResolveCtx } from './types.js';

/// Thrown when a required configuration row is missing. The worker boot
/// `assertConfigReady()` check catches this before activities run; if
/// somebody deletes a row at runtime, the activity itself will throw.
export class ConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigMissingError';
  }
}

/// Look up the credential for a provider at the given scope. Cascade is
/// TEAM → ORGANIZATION → GLOBAL (templates intentionally don't have their own
/// credentials — they reference an existing one). The ORGANIZATION tier only
/// fires when `ctx.orgId` is present. Throws `ConfigMissingError` when no
/// credential exists for the provider.
export async function resolveProviderCredential(
  provider: string,
  ctx?: ResolveCtx
): Promise<{ apiBase?: string; apiKey: string }> {
  const cacheKey = `cred:${provider}:${ctx?.teamId ?? ''}:${ctx?.orgId ?? ''}`;
  const resolved = await withCache(cacheKey, configCacheTtlMs(), () =>
    resolveProviderCredentialUncached(provider, ctx)
  );
  // When a more-specific request fell through to a less-specific scope, we
  // cached the broader credential under the narrower cache key. That would mask
  // a subsequent narrower insert for the full TTL — bust the cache now so the
  // next call re-queries and picks up the new row. (A TEAM request that landed
  // on ORG or GLOBAL, or an ORG request that landed on GLOBAL.)
  const fellThrough =
    (ctx?.teamId && resolved._scope !== 'TEAM') || (ctx?.orgId && resolved._scope === 'GLOBAL');
  if (fellThrough) {
    invalidate(cacheKey);
  }
  return { apiBase: resolved.apiBase, apiKey: resolved.apiKey };
}

interface ResolvedCredentialInternal {
  apiKey: string;
  apiBase?: string;
  /// Which scope the row came from — used by the wrapper above to detect
  /// cross-scope fallback. Not exposed to callers.
  _scope: 'TEAM' | 'ORGANIZATION' | 'GLOBAL';
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
  if (ctx?.orgId) {
    const row = await prisma.providerCredential.findFirst({
      where: { orgId: ctx.orgId, provider, scope: 'ORGANIZATION' },
    });
    if (row) {
      const decrypted = decryptRow(row);
      return { _scope: 'ORGANIZATION', apiBase: decrypted.apiBase, apiKey: decrypted.apiKey };
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
    // "fix it in the dashboard" affordance as a missing row.
    throw new ConfigMissingError(
      `Failed to decrypt ProviderCredential id=${row.id} (provider='${row.provider}', lastFour='${row.lastFour}'): ${err instanceof Error ? err.message : err}. Delete and re-create the credential via /admin/model-config.`
    );
  }
  return { apiBase: row.apiBase ?? undefined, apiKey };
}

/// Test-only helper. Forces the next call past the cache.
export { invalidate as _invalidateConfigCache };
