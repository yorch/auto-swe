import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { credFindFirstMock, credFindUniqueMock, embeddingFindUniqueMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn(),
  credFindUniqueMock: vi.fn(),
  embeddingFindUniqueMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embeddingFindUniqueMock },
    providerCredential: { findFirst: credFindFirstMock, findUnique: credFindUniqueMock },
  },
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { _resetKeyCacheForTests, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  ConfigMissingError,
  resolveEmbeddingConfig,
  resolvePinnedCredential,
  resolveProviderCredential,
} from './resolver.js';

// NOTE: per-role model resolution moved to the Agent entity (P1.5); see
// agentResolver.test.ts. This file covers the surviving credential + embedding
// resolution that the Agent layer reuses.

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  _resetConfigCacheForTests();
  credFindFirstMock.mockReset();
  credFindUniqueMock.mockReset();
  embeddingFindUniqueMock.mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function credRow(apiKey: string, apiBase: string | null = null) {
  const sealed = encryptSecret(apiKey);
  return {
    apiBase,
    apiKeyAuthTag: sealed.authTag,
    apiKeyCiphertext: sealed.ciphertext,
    apiKeyNonce: sealed.nonce,
    keyVersion: sealed.keyVersion,
  };
}

describe('resolveProviderCredential', () => {
  it('returns the team credential first', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') {
        return credRow('sk-team');
      }
      return credRow('sk-global');
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-team');
  });

  it('falls back to global when team credential is absent', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') {
        return credRow('sk-global');
      }
      return null;
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-global');
  });

  it('prefers an ORGANIZATION credential over GLOBAL when no team row exists (P5)', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'ORGANIZATION') {
        return credRow('sk-org');
      }
      if (args.where.scope === 'GLOBAL') {
        return credRow('sk-global');
      }
      return null;
    });

    const r = await resolveProviderCredential('anthropic', { orgId: 'o1', teamId: 't1' });
    expect(r.apiKey).toBe('sk-org');
  });

  it('cascades TEAM → ORGANIZATION → GLOBAL (P5)', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) =>
      args.where.scope === 'GLOBAL' ? credRow('sk-global') : null
    );

    const r = await resolveProviderCredential('anthropic', { orgId: 'o1', teamId: 't1' });
    expect(r.apiKey).toBe('sk-global');
  });

  it('throws ConfigMissingError when neither scope has the credential', async () => {
    credFindFirstMock.mockResolvedValue(null);

    await expect(resolveProviderCredential('anthropic')).rejects.toThrow(ConfigMissingError);
  });
});

describe('resolveEmbeddingConfig', () => {
  it('returns spec + pinned credential when EmbeddingConfig has credentialId', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-embed-pinned'),
      modelSpec: 'openai/text-embedding-3-large',
    });

    const r = await resolveEmbeddingConfig();
    expect(r.spec).toBe('openai/text-embedding-3-large');
    expect(r.apiKey).toBe('sk-embed-pinned');
  });

  it('falls back to provider-cascade credential when no pinned credential', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cascade'));

    const r = await resolveEmbeddingConfig();
    expect(r.apiKey).toBe('sk-cascade');
  });

  it('throws ConfigMissingError when the singleton row is absent', async () => {
    embeddingFindUniqueMock.mockResolvedValue(null);
    await expect(resolveEmbeddingConfig()).rejects.toThrow(ConfigMissingError);
    await expect(resolveEmbeddingConfig()).rejects.toThrow(/EmbeddingConfig/);
  });
});

describe('provider-credential cache', () => {
  it('caches a GLOBAL fall-through for a team, but only for the short fall-through TTL', async () => {
    vi.useFakeTimers();
    try {
      process.env.CONFIG_CACHE_TTL_MS = '30000';
      process.env.CONFIG_CACHE_FALLTHROUGH_TTL_MS = '5000';
      let teamHasCred = false;
      credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
        if (args.where.scope === 'TEAM') {
          return teamHasCred ? credRow('sk-team-new') : null;
        }
        return credRow('sk-global');
      });

      const r1 = await resolveProviderCredential('anthropic', { teamId: 't1' });
      expect(r1.apiKey).toBe('sk-global');

      // Within the short TTL the fall-through answer is served from cache: no re-query.
      teamHasCred = true;
      vi.advanceTimersByTime(4_000);
      const r2 = await resolveProviderCredential('anthropic', { teamId: 't1' });
      expect(r2.apiKey).toBe('sk-global');
      expect(credFindFirstMock).toHaveBeenCalledTimes(2); // TEAM + GLOBAL, once

      // Past it, the newly inserted team row is picked up well before the full TTL.
      vi.advanceTimersByTime(2_000);
      const r3 = await resolveProviderCredential('anthropic', { teamId: 't1' });
      expect(r3.apiKey).toBe('sk-team-new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets the fall-through TTL exceed the full TTL', async () => {
    vi.useFakeTimers();
    try {
      process.env.CONFIG_CACHE_TTL_MS = '1000';
      process.env.CONFIG_CACHE_FALLTHROUGH_TTL_MS = '60000';
      credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) =>
        args.where.scope === 'TEAM' ? null : credRow('sk-global')
      );
      await resolveProviderCredential('anthropic', { teamId: 't1' });
      vi.advanceTimersByTime(1_500);
      await resolveProviderCredential('anthropic', { teamId: 't1' });
      expect(credFindFirstMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps caching when the team-scope row WAS the one returned', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') {
        return credRow('sk-team');
      }
      return credRow('sk-global');
    });

    await resolveProviderCredential('anthropic', { teamId: 't1' });
    await resolveProviderCredential('anthropic', { teamId: 't1' });
    const teamCalls = credFindFirstMock.mock.calls.filter((c) => c[0].where.scope === 'TEAM');
    expect(teamCalls).toHaveLength(1);
  });
});

describe('resolvePinnedCredential', () => {
  function pinnedRow(overrides: Record<string, unknown> = {}) {
    return {
      ...credRow('sk-pinned', 'https://openrouter.ai/api/v1'),
      id: 'cred-pin',
      orgId: null,
      provider: 'openrouter',
      scope: 'GLOBAL',
      teamId: null,
      ...overrides,
    };
  }

  it('returns the decrypted GLOBAL credential for its own provider', async () => {
    credFindUniqueMock.mockResolvedValue(pinnedRow());
    await expect(resolvePinnedCredential('cred-pin', 'openrouter')).resolves.toEqual({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-pinned',
      ok: true,
    });
    expect(credFindUniqueMock).toHaveBeenCalledWith({ where: { id: 'cred-pin' } });
  });

  it('matches the provider case-insensitively, as the spec parser does', async () => {
    credFindUniqueMock.mockResolvedValue(pinnedRow({ provider: 'OpenRouter' }));
    const r = await resolvePinnedCredential('cred-pin', 'openrouter');
    expect(r.ok).toBe(true);
  });

  it('reports a deleted pin as missing', async () => {
    credFindUniqueMock.mockResolvedValue(null);
    await expect(resolvePinnedCredential('cred-pin', 'openrouter')).resolves.toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('refuses a credential of another provider', async () => {
    credFindUniqueMock.mockResolvedValue(pinnedRow({ provider: 'openai' }));
    await expect(resolvePinnedCredential('cred-pin', 'openrouter')).resolves.toEqual({
      ok: false,
      reason: 'provider-mismatch',
    });
  });

  it('honours a TEAM credential only for a run of that team', async () => {
    credFindUniqueMock.mockResolvedValue(pinnedRow({ scope: 'TEAM', teamId: 't-1' }));
    expect((await resolvePinnedCredential('cred-pin', 'openrouter', { teamId: 't-1' })).ok).toBe(
      true
    );
    _resetConfigCacheForTests();
    await expect(
      resolvePinnedCredential('cred-pin', 'openrouter', { teamId: 't-2' })
    ).resolves.toEqual({ ok: false, reason: 'out-of-scope' });
    _resetConfigCacheForTests();
    await expect(resolvePinnedCredential('cred-pin', 'openrouter')).resolves.toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('honours an ORGANIZATION credential only for a run in that org', async () => {
    credFindUniqueMock.mockResolvedValue(pinnedRow({ orgId: 'o-1', scope: 'ORGANIZATION' }));
    expect((await resolvePinnedCredential('cred-pin', 'openrouter', { orgId: 'o-1' })).ok).toBe(
      true
    );
    _resetConfigCacheForTests();
    await expect(
      resolvePinnedCredential('cred-pin', 'openrouter', { orgId: 'o-2' })
    ).resolves.toEqual({ ok: false, reason: 'out-of-scope' });
  });
});
