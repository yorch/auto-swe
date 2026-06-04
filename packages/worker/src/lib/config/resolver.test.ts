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
      if (args.where.scope === 'WORKFLOW_TEMPLATE') {
        return row('anthropic/opus-template');
      }
      return row('anthropic/opus-global');
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('anthropic/opus-template');
    expect(r.scope).toBe('WORKFLOW_TEMPLATE');
  });

  it('falls back to TEAM row when no WORKFLOW_TEMPLATE row exists', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'WORKFLOW_TEMPLATE') {
        return null;
      }
      if (args.where.scope === 'TEAM') {
        return row('openai/team');
      }
      return row('anthropic/global');
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cred'));

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('openai/team');
    expect(r.scope).toBe('TEAM');
  });

  it('falls back to GLOBAL row when no team or template row exists', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') {
        return row('anthropic/global');
      }
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
      if (args.where.scope === 'TEAM') {
        return credRow('sk-team');
      }
      return credRow('sk-global');
    });

    const r = await resolveModelConfig('implementer', { teamId: 't1' });
    expect(r.apiKey).toBe('sk-team');
  });

  it('falls back to global credential when team credential is absent', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/opus'));
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') {
        return credRow('sk-global');
      }
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

describe('resolveModelConfig — systemPrompt cascade', () => {
  it('returns systemPrompt from WORKFLOW_TEMPLATE row when set', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'WORKFLOW_TEMPLATE') {
        return {
          ...row('anthropic/claude-opus-4-7', credRow('key-a')),
          systemPrompt: 'custom tpl prompt',
        };
      }
      return null;
    });
    credFindFirstMock.mockResolvedValue(null);

    const result = await resolveModelConfig('implementer', {
      teamId: 'team-1',
      workflowTemplateId: 'tpl-1',
    });
    expect(result.systemPrompt).toBe('custom tpl prompt');
  });

  it('falls through to TEAM row systemPrompt when template row has none', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'WORKFLOW_TEMPLATE') {
        return { ...row('anthropic/claude-opus-4-7', credRow('key-a')), systemPrompt: null };
      }
      if (args.where.scope === 'TEAM') {
        return {
          ...row('anthropic/claude-opus-4-7', credRow('key-b')),
          systemPrompt: 'team prompt',
        };
      }
      return null;
    });
    credFindFirstMock.mockResolvedValue(null);

    const result = await resolveModelConfig('implementer', {
      teamId: 'team-1',
      workflowTemplateId: 'tpl-1',
    });
    expect(result.systemPrompt).toBe('team prompt');
  });

  it('returns undefined when no row has a systemPrompt', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') {
        return { ...row('anthropic/claude-opus-4-7', credRow('key-c')), systemPrompt: null };
      }
      return null;
    });
    credFindFirstMock.mockResolvedValue(null);

    const result = await resolveModelConfig('implementer');
    expect(result.systemPrompt).toBeUndefined();
  });

  it('returns systemPrompt from GLOBAL row when it is the only scope (no template, no team)', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') {
        return {
          ...row('anthropic/claude-opus-4-7', credRow('key-global')),
          systemPrompt: 'global prompt',
        };
      }
      return null;
    });
    credFindFirstMock.mockResolvedValue(null);

    const result = await resolveModelConfig('implementer');
    expect(result.systemPrompt).toBe('global prompt');
  });

  it('returns systemPrompt from TEAM row when it is the only scope (no template)', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') {
        return {
          ...row('anthropic/claude-opus-4-7', credRow('key-team')),
          systemPrompt: 'team only prompt',
        };
      }
      return null;
    });
    credFindFirstMock.mockResolvedValue(null);

    const result = await resolveModelConfig('implementer', { teamId: 'team-1' });
    expect(result.systemPrompt).toBe('team only prompt');
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

  it('busts the team-scope credential cache when GLOBAL was used as fallback', async () => {
    // Initially no TEAM credential — the resolver falls back to GLOBAL and
    // caches the result under 'cred:anthropic:t1'.
    let teamHasCred = false;
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') {
        return teamHasCred ? credRow('sk-team-new') : null;
      }
      return credRow('sk-global');
    });

    const r1 = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r1.apiKey).toBe('sk-global');

    // Operator now inserts a TEAM-scoped credential. Without cache busting,
    // the GLOBAL value would still be served for up to the TTL — billing
    // would go to the wrong account. The wrapper detects the cross-scope
    // fallback at write time and invalidates immediately.
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
    // Only one team-credential lookup — the second call hits the cache,
    // because no cross-scope fallback happened.
    const teamCalls = credFindFirstMock.mock.calls.filter((c) => c[0].where.scope === 'TEAM');
    expect(teamCalls).toHaveLength(1);
  });
});
