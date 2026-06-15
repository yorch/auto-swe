import { beforeEach, describe, expect, it, vi } from 'vitest';

const { roleFindFirst, credFindFirst, embedFindUnique } = vi.hoisted(() => ({
  credFindFirst: vi.fn(),
  embedFindUnique: vi.fn(),
  roleFindFirst: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embedFindUnique },
    modelRoleConfig: { findFirst: roleFindFirst },
    providerCredential: { findFirst: credFindFirst },
  },
}));

import { assertConfigReady } from './assertReady.js';

const ALL_AGENT_ROLES = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
];

beforeEach(() => {
  roleFindFirst.mockReset();
  credFindFirst.mockReset();
  embedFindUnique.mockReset();
});

function fullyConfigured() {
  // Every role lookup returns a healthy spec with no pinned credential.
  roleFindFirst.mockImplementation(async () => ({
    credential: null,
    modelSpec: 'anthropic/claude-opus-4-7',
  }));
  // Every provider lookup returns a credential.
  credFindFirst.mockImplementation(async () => ({ id: 'c1' }));
  embedFindUnique.mockResolvedValue({
    credential: null,
    modelSpec: 'openai/text-embedding-3-large',
  });
}

describe('assertConfigReady', () => {
  it('passes when all required rows exist', async () => {
    fullyConfigured();
    await expect(assertConfigReady()).resolves.toBeUndefined();
    expect(roleFindFirst).toHaveBeenCalledTimes(ALL_AGENT_ROLES.length);
  });

  it('reports every missing role in a single error', async () => {
    roleFindFirst.mockResolvedValue(null);
    credFindFirst.mockResolvedValue({ id: 'c1' });
    embedFindUnique.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    for (const role of [
      'implementer',
      'reviewer',
      'planner',
      'securityReview',
      'validateContext',
      'commitToMemory',
    ]) {
      expect(err.message).toContain(role);
    }
  });

  it('reports missing credentials when the role row exists but no credential matches the provider', async () => {
    roleFindFirst.mockImplementation(async () => ({
      credential: null,
      modelSpec: 'opencodego/glm-5',
    }));
    credFindFirst.mockResolvedValue(null);
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'openai' },
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain("ProviderCredential for provider 'opencodego'");
  });

  it('skips the per-provider credential check when the role pins a matching credential', async () => {
    roleFindFirst.mockImplementation(async () => ({
      credential: { provider: 'opencodego' }, // pinned to matching provider
      modelSpec: 'opencodego/glm-5',
    }));
    credFindFirst.mockResolvedValue(null);
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'openai' },
      modelSpec: 'openai/text-embedding-3-large',
    });

    await expect(assertConfigReady()).resolves.toBeUndefined();
    expect(credFindFirst).not.toHaveBeenCalled();
  });

  it('rejects a pinned credential whose provider does not match the role spec', async () => {
    roleFindFirst.mockImplementation(async () => ({
      credential: { provider: 'openai' }, // wrong provider for an anthropic spec
      modelSpec: 'anthropic/claude-opus-4-7',
    }));
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'openai' },
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain("pins a credential for a different provider 'openai'");
  });

  it('rejects an EmbeddingConfig pin whose provider does not match the spec', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'anthropic' }, // wrong provider for an openai/* spec
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('EmbeddingConfig');
    expect(err.message).toContain("pins a credential for a different provider 'anthropic'");
  });

  it('reports missing EmbeddingConfig row', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue(null);

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('EmbeddingConfig');
  });

  it('reports invalid modelSpec on the embedding row', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue({ credential: null, modelSpec: 'no-slash' });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('invalid modelSpec');
  });

  it('rolls up multiple missing pieces into one bootstrap message', async () => {
    roleFindFirst.mockResolvedValue(null);
    credFindFirst.mockResolvedValue(null);
    embedFindUnique.mockResolvedValue(null);

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('LLM configuration incomplete');
    expect(err.message).toContain('docs/model-configuration.md');
  });
});
