import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirstMock, credFindFirstMock, embeddingFindUniqueMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn(),
  embeddingFindUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embeddingFindUniqueMock },
    modelRoleConfig: { findFirst: findFirstMock },
    providerCredential: { findFirst: credFindFirstMock },
  },
}));

import { _resetKeyCacheForTests, encryptSecret } from '@auto-swe/shared/lib/crypto';
import { _resetConfigCacheForTests } from './cache.js';
import {
  ConfigMissingError,
  resolveEmbeddingConfig,
  resolveModelConfig,
  resolveProviderCredential,
} from './resolver.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  _resetConfigCacheForTests();
  findFirstMock.mockReset();
  credFindFirstMock.mockReset();
  embeddingFindUniqueMock.mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function row(modelSpec: string, credential: ReturnType<typeof credRow> | null = null) {
  return { credential, modelSpec };
}

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

describe('resolveModelConfig — cascade', () => {
  it('returns WORKFLOW_TEMPLATE row first when present', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'WORKFLOW_TEMPLATE') return row('anthropic/opus-template');
      return row('anthropic/opus-global');
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('anthropic/opus-template');
    expect(r.scope).toBe('WORKFLOW_TEMPLATE');
  });

  it('falls back to TEAM row when no WORKFLOW_TEMPLATE row exists', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'WORKFLOW_TEMPLATE') return null;
      if (args.where.scope === 'TEAM') return row('openai/team');
      return row('anthropic/global');
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('openai/team');
    expect(r.scope).toBe('TEAM');
  });

  it('falls back to GLOBAL row when no team or template row exists', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') return row('anthropic/global');
      return null;
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('anthropic/global');
    expect(r.scope).toBe('GLOBAL');
  });

  it('throws ConfigMissingError when no GLOBAL row exists for the role', async () => {
    findFirstMock.mockResolvedValue(null);
    await expect(resolveModelConfig('implementer')).rejects.toThrow(ConfigMissingError);
    await expect(resolveModelConfig('implementer')).rejects.toThrow(/GLOBAL ModelRoleConfig/);
  });
});

describe('resolveModelConfig — credentials', () => {
  it('returns credential pinned on the role row (template override)', async () => {
    findFirstMock.mockResolvedValue(
      row('opencodego/glm-5', credRow('sk-pinned', 'https://opencode.ai/zen/go/v1'))
    );

    const r = await resolveModelConfig('implementer', { workflowTemplateId: 'tpl1' });
    expect(r.apiKey).toBe('sk-pinned');
    expect(r.apiBase).toBe('https://opencode.ai/zen/go/v1');
  });

  it('cascades to provider credentials when role row has no pinned credential', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/opus'));
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') return credRow('sk-team');
      return credRow('sk-global');
    });

    const r = await resolveModelConfig('implementer', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-team');
  });

  it('falls back to global credential when team credential is absent', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/opus'));
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') return credRow('sk-global');
      return null;
    });

    const r = await resolveModelConfig('implementer', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-global');
  });

  it('throws ConfigMissingError when no credential exists for the provider', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/opus'));
    credFindFirstMock.mockResolvedValue(null);

    await expect(resolveModelConfig('implementer')).rejects.toThrow(ConfigMissingError);
    await expect(resolveModelConfig('implementer')).rejects.toThrow(/ProviderCredential/);
  });
});

describe('resolveProviderCredential', () => {
  it('returns the team credential first', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') return credRow('sk-team');
      return credRow('sk-global');
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-team');
  });

  it('falls back to global when team credential is absent', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') return credRow('sk-global');
      return null;
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
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

describe('resolver cache', () => {
  it('hits the cache on the second call with the same context', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/global'));
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    await resolveModelConfig('implementer');
    await resolveModelConfig('implementer');

    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it('treats different ctx keys as separate cache entries', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/global'));
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    await resolveModelConfig('implementer', { teamId: 't1' });
    await resolveModelConfig('implementer', { teamId: 't2' });

    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });
});
