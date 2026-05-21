import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirstMock, credFindFirstMock } = vi.hoisted(() => ({
  credFindFirstMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    modelRoleConfig: { findFirst: findFirstMock },
    providerCredential: { findFirst: credFindFirstMock },
  },
}));

import { _resetKeyCacheForTests, encryptSecret } from '@auto-swe/shared/lib/crypto';
import { _resetConfigCacheForTests } from './cache.js';
import { resolveModelConfig, resolveProviderCredential } from './resolver.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  _resetConfigCacheForTests();
  findFirstMock.mockReset();
  credFindFirstMock.mockReset();
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

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('openai/team');
    expect(r.scope).toBe('TEAM');
  });

  it('falls back to GLOBAL row when no team or template row exists', async () => {
    findFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') return row('anthropic/global');
      return null;
    });

    const r = await resolveModelConfig('implementer', { teamId: 't1', workflowTemplateId: 'tpl1' });
    expect(r.spec).toBe('anthropic/global');
    expect(r.scope).toBe('GLOBAL');
  });

  it('falls back to env vars when no DB row exists at all', async () => {
    findFirstMock.mockResolvedValue(null);
    process.env.IMPLEMENTER_MODEL = 'openai/gpt-5-5';

    const r = await resolveModelConfig('implementer');
    expect(r.spec).toBe('openai/gpt-5-5');
    expect(r.scope).toBe('ENV_FALLBACK');
  });

  it('uses the default model when neither DB nor env are set', async () => {
    findFirstMock.mockResolvedValue(null);

    const r = await resolveModelConfig('planner');
    expect(r.spec).toMatch(/^anthropic\/claude-sonnet/);
    expect(r.scope).toBe('ENV_FALLBACK');
  });

  it('does not query TEAM or WORKFLOW_TEMPLATE scope when ctx fields are absent', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/global'));

    await resolveModelConfig('implementer');
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findFirstMock.mock.calls[0][0].where.scope).toBe('GLOBAL');
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

  it('returns undefined apiKey when no credential is configured', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/opus'));
    credFindFirstMock.mockResolvedValue(null);

    const r = await resolveModelConfig('implementer');
    expect(r.apiKey).toBeUndefined();
  });
});

describe('resolveProviderCredential', () => {
  it('returns the team credential first', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'TEAM') return credRow('sk-team');
      return credRow('sk-global');
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r?.apiKey).toBe('sk-team');
  });

  it('falls back to global when team credential is absent', async () => {
    credFindFirstMock.mockImplementation(async (args: { where: { scope: string } }) => {
      if (args.where.scope === 'GLOBAL') return credRow('sk-global');
      return null;
    });

    const r = await resolveProviderCredential('anthropic', { teamId: 't1' });
    expect(r?.apiKey).toBe('sk-global');
  });

  it('returns undefined when neither scope has the credential', async () => {
    credFindFirstMock.mockResolvedValue(null);

    const r = await resolveProviderCredential('anthropic');
    expect(r).toBeUndefined();
  });
});

describe('resolver cache', () => {
  it('hits the cache on the second call with the same context', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/global'));

    await resolveModelConfig('implementer');
    await resolveModelConfig('implementer');

    expect(findFirstMock).toHaveBeenCalledTimes(1);
  });

  it('treats different ctx keys as separate cache entries', async () => {
    findFirstMock.mockResolvedValue(row('anthropic/global'));

    await resolveModelConfig('implementer', { teamId: 't1' });
    await resolveModelConfig('implementer', { teamId: 't2' });

    expect(findFirstMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache ENV_FALLBACK results — a fresh DB row takes effect immediately', async () => {
    // First call: no DB row, env fallback returned.
    findFirstMock.mockResolvedValueOnce(null);
    const first = await resolveModelConfig('implementer');
    expect(first.scope).toBe('ENV_FALLBACK');

    // Second call: a row now exists (operator added it). Cache must not pin the env result.
    findFirstMock.mockResolvedValueOnce(row('anthropic/just-seeded'));
    const second = await resolveModelConfig('implementer');
    expect(second.scope).toBe('GLOBAL');
    expect(second.spec).toBe('anthropic/just-seeded');
  });

  it('does NOT cache missing credentials — a freshly-added credential takes effect immediately', async () => {
    credFindFirstMock.mockResolvedValueOnce(null);
    const first = await resolveProviderCredential('anthropic');
    expect(first).toBeUndefined();

    credFindFirstMock.mockResolvedValueOnce(credRow('sk-just-added'));
    const second = await resolveProviderCredential('anthropic');
    expect(second?.apiKey).toBe('sk-just-added');
  });
});

describe('env-fallback + DB credential interaction', () => {
  it('returns env-fallback spec without an apiKey (caller falls back to env-driven client)', async () => {
    findFirstMock.mockResolvedValue(null);
    credFindFirstMock.mockResolvedValue(credRow('sk-not-consulted'));
    process.env.IMPLEMENTER_MODEL = 'anthropic/opus-from-env';

    const r = await resolveModelConfig('implementer');
    expect(r.scope).toBe('ENV_FALLBACK');
    expect(r.spec).toBe('anthropic/opus-from-env');
    // No DB credential consulted — env fallback assumes the env-driven provider
    // client will pick up its own API key from process.env.
    expect(r.apiKey).toBeUndefined();
    expect(credFindFirstMock).not.toHaveBeenCalled();
  });
});
