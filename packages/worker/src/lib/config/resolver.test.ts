import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { credFindFirstMock, embeddingFindUniqueMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn(),
  embeddingFindUniqueMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embeddingFindUniqueMock },
    providerCredential: { findFirst: credFindFirstMock },
  },
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { _resetKeyCacheForTests, encryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  ConfigMissingError,
  resolveEmbeddingConfig,
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
  it('busts the team-scope credential cache when GLOBAL was used as fallback', async () => {
    let teamHasCred = false;
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') {
        return teamHasCred ? credRow('sk-team-new') : null;
      }
      return credRow('sk-global');
    });

    const r1 = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r1.apiKey).toBe('sk-global');

    teamHasCred = true;
    const r2 = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r2.apiKey).toBe('sk-team-new');
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
