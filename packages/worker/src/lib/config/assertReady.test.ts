import { beforeEach, describe, expect, it, vi } from 'vitest';

const { credFindFirst, embedFindUnique, resolveAgentMock } = vi.hoisted(() => ({
  credFindFirst: vi.fn(),
  embedFindUnique: vi.fn(),
  resolveAgentMock: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embedFindUnique },
    providerCredential: { findFirst: credFindFirst },
  },
}));

// Per-agent readiness now goes through resolveAgent (the Agent entity is the
// single source of truth, P1.5). The embedding check still reads prisma directly.
vi.mock('./agentResolver.js', () => ({ resolveAgent: resolveAgentMock }));

import { assertConfigReady } from './assertReady.js';
import { requiredAgentKeys } from './stepRequiredAgents.js';

const ALL_MODEL_BACKED_AGENT_KEYS = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
];

beforeEach(() => {
  resolveAgentMock.mockReset();
  credFindFirst.mockReset();
  embedFindUnique.mockReset();
});

/** Every required Agent resolves, and the embedding singleton is healthy. */
function fullyConfigured() {
  resolveAgentMock.mockResolvedValue({ key: 'x', model: { spec: 'anthropic/x' } });
  credFindFirst.mockImplementation(async () => ({ id: 'c1' }));
  embedFindUnique.mockResolvedValue({
    credential: null,
    modelSpec: 'openai/text-embedding-3-large',
  });
}

describe('requiredAgentKeys', () => {
  it('computes the deduped union of every registered step’s required agents', () => {
    expect([...requiredAgentKeys()].sort()).toEqual([...ALL_MODEL_BACKED_AGENT_KEYS].sort());
  });
});

describe('assertConfigReady', () => {
  it('passes when every required Agent resolves and the embedding is healthy', async () => {
    fullyConfigured();
    await expect(assertConfigReady()).resolves.toBeUndefined();
    expect(resolveAgentMock).toHaveBeenCalledTimes(ALL_MODEL_BACKED_AGENT_KEYS.length);
  });

  it('reports every Agent that fails to resolve in a single error', async () => {
    resolveAgentMock.mockRejectedValue(new Error('No active Agent found'));
    embedFindUnique.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });
    credFindFirst.mockResolvedValue({ id: 'c1' });

    const err = await assertConfigReady().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    for (const role of ALL_MODEL_BACKED_AGENT_KEYS) {
      expect(err.message).toContain(role);
    }
  });

  it('surfaces a resolveAgent credential failure for a role', async () => {
    resolveAgentMock.mockImplementation(async (key: string) => {
      if (key === 'implementer') {
        throw new Error("No ProviderCredential for provider 'opencodego'");
      }
      return { key, model: { spec: 'anthropic/x' } };
    });
    credFindFirst.mockResolvedValue({ id: 'c1' });
    embedFindUnique.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain("ProviderCredential for provider 'opencodego'");
  });

  it('rejects an EmbeddingConfig pin whose provider does not match the spec', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'anthropic' },
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
    resolveAgentMock.mockRejectedValue(new Error('No active Agent found'));
    credFindFirst.mockResolvedValue(null);
    embedFindUnique.mockResolvedValue(null);

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('LLM configuration incomplete');
    expect(err.message).toContain('docs/model-configuration.md');
  });
});
