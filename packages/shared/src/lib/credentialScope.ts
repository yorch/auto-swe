import { ConfigScope } from '../generated/prisma/enums.js';

/// Narrow form of ConfigScope that the `provider_credentials` table actually
/// accepts. The Prisma model uses the wider ConfigScope enum (so it shares
/// the type with ModelRoleConfig) but the migration adds a DB-level CHECK
/// constraint (`provider_credentials_scope_check`) accepting only `GLOBAL`,
/// `ORGANIZATION` and `TEAM` — `WORKFLOW_TEMPLATE` and `CHANNEL` are rejected. Use this type and the runtime
/// guards below when writing to `prisma.providerCredential.create()` /
/// `.update()` — the gateway routes already enforce via Zod, but anyone
/// reaching past the routes (CLI, scripts, future code) should run input
/// through `assertCredentialScope` first to fail at the boundary rather
/// than with an opaque P2010 from Postgres.
export type CredentialScope = 'GLOBAL' | 'ORGANIZATION' | 'TEAM';

export function isCredentialScope(value: unknown): value is CredentialScope {
  return (
    value === ConfigScope.GLOBAL || value === ConfigScope.ORGANIZATION || value === ConfigScope.TEAM
  );
}

export function assertCredentialScope(value: unknown): CredentialScope {
  if (!isCredentialScope(value)) {
    throw new Error(
      `Invalid ProviderCredential scope '${String(value)}'. The 'provider_credentials.scope' column accepts only 'GLOBAL', 'ORGANIZATION' or 'TEAM' (see schema.prisma and the provider_credentials_scope_check constraint).`
    );
  }
  return value;
}
