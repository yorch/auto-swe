import { prisma } from '@auto-swe/shared/db';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { ALL_ROLES, envCredentialsFromProcess, envFallbackSpec } from './resolver.js';
import { ROLE_TO_PRISMA } from './types.js';

/// Prisma's known unique-constraint error code.
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}

/// One-shot bootstrap that copies env-var configuration into the DB so the
/// resolver can take over. Idempotent — only seeds tables that are currently
/// empty at GLOBAL scope, so a second worker boot is a no-op.
///
/// Runs at worker startup. Failures are logged but not fatal: if the DB is
/// unreachable, the worker can still come up and the resolver's env fallback
/// will keep activities running until the DB recovers.
export async function seedConfigFromEnv(): Promise<{
  rolesSeeded: number;
  credentialsSeeded: number;
  skipped: 'no-roles-needed' | 'no-credentials-needed' | 'both-needed' | 'fresh';
}> {
  // Count existing GLOBAL rows so we know whether to seed.
  const [existingGlobalRoles, existingGlobalCreds] = await Promise.all([
    prisma.modelRoleConfig.count({ where: { scope: 'GLOBAL' } }),
    prisma.providerCredential.count({ where: { scope: 'GLOBAL' } }),
  ]);

  let rolesSeeded = 0;
  let credentialsSeeded = 0;

  // Insert one row at a time and swallow P2002 unique-constraint failures —
  // partial unique indexes on `(role)` / `(provider)` WHERE scope='GLOBAL'
  // make concurrent worker boots safe. The TOCTOU between count() and create
  // is intentional: the count() is for the return value only; correctness
  // comes from the unique constraint.
  if (existingGlobalRoles === 0) {
    for (const role of ALL_ROLES) {
      try {
        await prisma.modelRoleConfig.create({
          data: {
            modelSpec: envFallbackSpec(role),
            role: ROLE_TO_PRISMA[role],
            scope: 'GLOBAL',
          },
        });
        rolesSeeded += 1;
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
    }
  }

  if (existingGlobalCreds === 0) {
    for (const cred of envCredentialsFromProcess()) {
      const sealed = encryptSecret(cred.apiKey);
      try {
        await prisma.providerCredential.create({
          data: {
            apiBase: cred.apiBase,
            apiKeyAuthTag: sealed.authTag,
            apiKeyCiphertext: sealed.ciphertext,
            apiKeyNonce: sealed.nonce,
            keyVersion: sealed.keyVersion,
            lastFour: sealed.lastFour,
            provider: cred.provider,
            scope: 'GLOBAL',
          },
        });
        credentialsSeeded += 1;
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
      }
    }
  }

  let skipped: 'no-roles-needed' | 'no-credentials-needed' | 'both-needed' | 'fresh' = 'fresh';
  if (existingGlobalRoles > 0 && existingGlobalCreds > 0) skipped = 'both-needed';
  else if (existingGlobalRoles > 0) skipped = 'no-roles-needed';
  else if (existingGlobalCreds > 0) skipped = 'no-credentials-needed';

  return { credentialsSeeded, rolesSeeded, skipped };
}
