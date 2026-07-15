import type { PrismaClient } from '@auto-swe/shared';
import { encryptSecret } from '@auto-swe/shared/lib/crypto';
import { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { isUniqueConstraintError } from './prismaErrors.js';

// Re-exported for back-compat: existing tests (and any other importers) reach
// the SSRF guard via `credentialService.js`. The canonical implementation now
// lives in `@auto-swe/shared/lib/ssrfGuard` so every operator-URL call site
// (mcp Connections, connector base URLs, bundle install-from-URL, worker MCP
// refs) shares one definition.
export { isSafeProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';

/**
 * Provider-credential service: redaction, SSRF-guarded probing, and the
 * create/update flows shared by the admin routes (`/api/v1/admin/credentials`)
 * and the team-scoped routes (`/api/v1/teams/:id/credentials`). Functions take
 * `prisma` as an argument — no Fastify coupling — so they are unit-testable
 * and callable from any route variant.
 */

export type ProviderCredentialRow = NonNullable<
  Awaited<ReturnType<PrismaClient['providerCredential']['findFirst']>>
>;

/// Strips the encrypted bytes from a credential row before returning it.
/// Plaintext API keys never leave the gateway.
export function redactCredential(row: {
  id: string;
  provider: string;
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM' | 'CHANNEL' | 'WORKFLOW_TEMPLATE';
  teamId: string | null;
  orgId: string | null;
  apiBase: string | null;
  lastFour: string;
  keyVersion: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    apiBase: row.apiBase,
    createdAt: row.createdAt,
    createdById: row.createdById,
    id: row.id,
    keyVersion: row.keyVersion,
    lastFour: row.lastFour,
    maskedKey: `****${row.lastFour}`,
    orgId: row.orgId,
    provider: row.provider,
    scope: row.scope,
    teamId: row.teamId,
    updatedAt: row.updatedAt,
  };
}

const PROBE_TIMEOUT_MS = 5_000;

/// Issues a minimal HTTP probe against the configured provider to verify the
/// credential works. Returns `{ ok, status, error? }`. Best-effort — not all
/// providers expose a cheap "list models" endpoint, so failures here are not
/// authoritative.
export async function probeCredential(args: {
  provider: string;
  apiKey: string;
  apiBase?: string | null;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { provider, apiKey, apiBase } = args;
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey },
        signal,
      });
      return { ok: res.ok, status: res.status };
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      return { ok: res.ok, status: res.status };
    }
    if (provider === 'google') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal }
      );
      return { ok: res.ok, status: res.status };
    }
    // OpenAI-compatible: probe `<base>/models`. SSRF guards run here.
    if (!apiBase) {
      return { error: 'apiBase required to probe OpenAI-compatible providers', ok: false };
    }
    const safety = isSafeProbeUrl(apiBase);
    if (!safety.ok) {
      return { error: `apiBase rejected: ${safety.reason}`, ok: false };
    }
    const base = safety.url.toString().replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), ok: false };
  }
}

/// Best-effort credential probe for a stored row. Decrypts the key in-memory
/// and issues a list-models HTTP request. The plaintext key never leaves the
/// process — only the HTTP status is returned to the caller.
export async function testStoredCredential(cred: {
  provider: string;
  apiBase: string | null;
  apiKeyAuthTag: Buffer | Uint8Array;
  apiKeyCiphertext: Buffer | Uint8Array;
  apiKeyNonce: Buffer | Uint8Array;
  keyVersion: number;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  // Import the decrypt helper lazily — keeps the cold path off the
  // critical request path for routes that don't need it.
  const { decryptSecret } = await import('@auto-swe/shared/lib/crypto');
  const apiKey = decryptSecret({
    authTag: cred.apiKeyAuthTag,
    ciphertext: cred.apiKeyCiphertext,
    keyVersion: cred.keyVersion,
    nonce: cred.apiKeyNonce,
  });
  return probeCredential({ apiBase: cred.apiBase, apiKey, provider: cred.provider });
}

export type CreateCredentialInput = {
  actorId: string;
  apiBase?: string | null;
  apiKey: string;
  provider: string;
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
  teamId?: string | null;
  orgId?: string | null;
};

export type CreateCredentialResult =
  | { outcome: 'conflict'; existingId: string }
  | { outcome: 'conflict_race' }
  | { outcome: 'created'; credential: ProviderCredentialRow };

/// Creates a provider credential at GLOBAL, ORGANIZATION, or TEAM scope.
/// Pre-flight checks for an existing row at the same (provider, scope, key)
/// tuple, then catches the P2002 from a lost create race so both surface as a
/// conflict rather than a 500. Used by the admin and team-scoped routes alike.
export async function createCredential(
  prisma: PrismaClient,
  input: CreateCredentialInput
): Promise<CreateCredentialResult> {
  const teamId = input.scope === 'TEAM' ? (input.teamId ?? null) : null;
  const orgId = input.scope === 'ORGANIZATION' ? (input.orgId ?? null) : null;
  const existing = await prisma.providerCredential.findFirst({
    where: { orgId, provider: input.provider, scope: input.scope, teamId },
  });
  if (existing) {
    return { existingId: existing.id, outcome: 'conflict' };
  }

  const sealed = encryptSecret(input.apiKey);
  try {
    const created = await prisma.providerCredential.create({
      data: {
        apiBase: input.apiBase ?? null,
        apiKeyAuthTag: sealed.authTag,
        apiKeyCiphertext: sealed.ciphertext,
        apiKeyNonce: sealed.nonce,
        createdById: input.actorId,
        keyVersion: sealed.keyVersion,
        lastFour: sealed.lastFour,
        orgId,
        provider: input.provider,
        scope: input.scope,
        teamId,
      },
    });
    return { credential: created, outcome: 'created' };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // Lost race with a concurrent POST — surface as a conflict, same as
      // the pre-flight check would have.
      return { outcome: 'conflict_race' };
    }
    throw err;
  }
}

/// Applies a partial credential update: `apiBase` is written when provided
/// (null clears it); a non-empty `apiKey` re-encrypts the whole AES-GCM
/// envelope. Shared by the admin and team-scoped PUT routes — ownership /
/// existence checks stay with the caller.
export async function updateCredential(
  prisma: PrismaClient,
  id: string,
  body: { apiBase?: string | null; apiKey?: string }
): Promise<ProviderCredentialRow> {
  const { apiBase, apiKey } = body;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic update shape
  const data: Record<string, any> = {};
  if (apiBase !== undefined) {
    data.apiBase = apiBase;
  }
  if (apiKey) {
    const sealed = encryptSecret(apiKey);
    data.apiKeyCiphertext = sealed.ciphertext;
    data.apiKeyNonce = sealed.nonce;
    data.apiKeyAuthTag = sealed.authTag;
    data.keyVersion = sealed.keyVersion;
    data.lastFour = sealed.lastFour;
  }
  return prisma.providerCredential.update({ data, where: { id } });
}
