import { ConfigScope } from '../generated/prisma/enums.js';

/// Narrow form of ConfigScope that the `provider_credentials` table actually
/// accepts. The Prisma model uses the wider ConfigScope enum (so it shares
/// the type with ModelRoleConfig) but the migration adds a DB-level CHECK
/// constraint rejecting `WORKFLOW_TEMPLATE`. Use this type and the runtime
/// guards below when writing to `prisma.providerCredential.create()` /
/// `.update()` — the gateway routes already enforce via Zod, but anyone
/// reaching past the routes (CLI, scripts, future code) should run input
/// through `assertCredentialScope` first to fail at the boundary rather
/// than with an opaque P2010 from Postgres.
export type CredentialScope = 'GLOBAL' | 'TEAM';

export function isCredentialScope(value: unknown): value is CredentialScope {
  return value === ConfigScope.GLOBAL || value === ConfigScope.TEAM;
}

export function assertCredentialScope(value: unknown): CredentialScope {
  if (!isCredentialScope(value)) {
    throw new Error(
      `Invalid ProviderCredential scope '${String(value)}'. The 'provider_credentials.scope' column accepts only 'GLOBAL' or 'TEAM' (see schema.prisma and the embedding_configs_scope_keys_check constraint).`
    );
  }
  return value;
}
