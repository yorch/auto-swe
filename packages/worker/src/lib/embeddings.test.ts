import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  embedMock,
  openaiEmbeddingFactory,
  openaiCompatTextEmbeddingFactory,
  embeddingFindUniqueMock,
  credFindFirstMock,
  activity,
  traceCreateMock,
  runFindUniqueMock,
  ledgerUpdateManyMock,
} = vi.hoisted(() => ({
  activity: { inActivity: false },
  credFindFirstMock: vi.fn().mockResolvedValue(null),
  embeddingFindUniqueMock: vi.fn(),
  embedMock: vi.fn(),
  ledgerUpdateManyMock: vi.fn(),
  openaiCompatTextEmbeddingFactory: vi.fn(),
  openaiEmbeddingFactory: vi.fn(),
  runFindUniqueMock: vi.fn(),
  traceCreateMock: vi.fn(),
}));

vi.mock('ai', () => ({
  embed: embedMock,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => ({ embedding: openaiEmbeddingFactory })),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => ({ textEmbeddingModel: openaiCompatTextEmbeddingFactory })),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { updateMany: ledgerUpdateManyMock },
    agentTrace: { create: traceCreateMock },
    embeddingConfig: { findUnique: embeddingFindUniqueMock },
    providerCredential: { findFirst: credFindFirstMock },
    workflowRun: { findUnique: runFindUniqueMock },
  },
}));

function requireActivity<T>(value: T): T {
  if (!activity.inActivity) {
    throw new Error('not in an activity');
  }
  return value;
}

vi.mock('./activityContext.js', () => ({
  currentActivityType: () => requireActivity('commitToMemory'),
  currentAttempt: () => requireActivity(2),
  currentWorkflowId: () => requireActivity('wf-1'),
}));

vi.mock('./costTracking.js', () => ({
  calculateCostUsd: async (spec: string, input: number) =>
    spec === 'openai/text-embedding-3-large' ? (input * 0.13) / 1_000_000 : 0,
}));

import { _resetConfigCacheForTests } from '@auto-swe/shared/config/cache';
import { _resetKeyCacheForTests, encryptSecret } from '@auto-swe/shared/lib/crypto';
import { ConfigMissingError } from './config/resolver.js';
import { _resetEmbeddingClientForTests, generateEmbedding } from './embeddings.js';
import { withSpendOwner } from './spendOwner.js';

const originalEnv = { ...process.env };

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

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  _resetConfigCacheForTests();
  _resetEmbeddingClientForTests();
  embedMock.mockReset();
  openaiEmbeddingFactory.mockReset().mockReturnValue({ tag: 'openai-embed' });
  openaiCompatTextEmbeddingFactory.mockReset().mockReturnValue({ tag: 'compat-embed' });
  embeddingFindUniqueMock.mockReset();
  credFindFirstMock.mockReset();
  traceCreateMock.mockReset().mockResolvedValue({});
  runFindUniqueMock.mockReset().mockResolvedValue({ id: 'run-1' });
  ledgerUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
  activity.inActivity = false;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('generateEmbedding', () => {
  it('uses the DB-configured OpenAI spec + credential', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-from-db-1234'),
      modelSpec: 'openai/text-embedding-3-large',
    });
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0.1) });

    const v = await generateEmbedding('hello world');

    expect(v).toHaveLength(1536);
    expect(openaiEmbeddingFactory).toHaveBeenCalledWith('text-embedding-3-large');
    expect(embedMock).toHaveBeenCalledWith({
      model: { tag: 'openai-embed' },
      providerOptions: { openai: { dimensions: 1536 } },
      value: 'hello world',
    });
  });

  it('falls back to provider-cascade credential when EmbeddingConfig has no pinned cred', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });
    credFindFirstMock.mockResolvedValue(credRow('sk-cascade-9999'));
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0) });

    await generateEmbedding('x');
    expect(openaiEmbeddingFactory).toHaveBeenCalledWith('text-embedding-3-large');
  });

  it('routes OpenAI-compatible providers through the compat client (apiBase required)', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-ollama', 'http://localhost:11434/v1'),
      modelSpec: 'ollama/nomic-embed-text',
    });
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0) });

    await generateEmbedding('hi');

    expect(openaiCompatTextEmbeddingFactory).toHaveBeenCalledWith('nomic-embed-text');
    // OpenAI-specific providerOptions (dimensions) must NOT be forwarded to non-OpenAI providers.
    expect(embedMock).toHaveBeenCalledWith({
      model: { tag: 'compat-embed' },
      value: 'hi',
    });
  });

  it('throws ConfigMissingError when EmbeddingConfig row is absent', async () => {
    embeddingFindUniqueMock.mockResolvedValue(null);
    await expect(generateEmbedding('x')).rejects.toThrow(ConfigMissingError);
  });

  it('throws when an OpenAI-compatible provider has no apiBase', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-key-no-base'),
      modelSpec: 'ollama/nomic-embed-text',
    });
    await expect(generateEmbedding('x')).rejects.toThrow(/apiBase/);
  });

  it('rejects malformed embedding specs', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-x'),
      modelSpec: 'no-slash',
    });
    await expect(generateEmbedding('x')).rejects.toThrow(/provider.*model/i);
  });

  it('throws when the embedding is too small for the pgvector column', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-x'),
      modelSpec: 'openai/text-embedding-3-large',
    });
    embedMock.mockResolvedValue({ embedding: new Array(768).fill(0) });
    await expect(generateEmbedding('x')).rejects.toThrow(/768.*1536/);
  });

  it('throws when the embedding is too large for the pgvector column', async () => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-x'),
      modelSpec: 'openai/text-embedding-3-large',
    });
    embedMock.mockResolvedValue({ embedding: new Array(3072).fill(0) });
    await expect(generateEmbedding('x')).rejects.toThrow(/3072.*1536/);
  });
});

describe('embedding usage recording', () => {
  beforeEach(() => {
    embeddingFindUniqueMock.mockResolvedValue({
      credential: credRow('sk-from-db-1234'),
      modelSpec: 'openai/text-embedding-3-large',
    });
  });

  it('writes a priced trace row and debits only cost on the ledger', async () => {
    activity.inActivity = true;
    embedMock.mockResolvedValue({
      embedding: new Array(1536).fill(0),
      usage: { tokens: 1_000_000 },
    });

    await generateEmbedding('hello');

    expect(traceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agentKey: 'embedding',
        attempt: 2,
        costUsd: 0.13,
        inputJson: { chars: 5 },
        inputTokens: 1_000_000,
        model: 'openai/text-embedding-3-large',
        nodeId: 'commitToMemory',
        outputTokens: 0,
        runId: 'run-1',
        type: 'llm_response',
        workflowId: 'wf-1',
      }),
    });
    // Token counters are what tier budgets measure, so only cost moves.
    expect(ledgerUpdateManyMock).toHaveBeenCalledWith({
      data: { costUsdAccrued: { increment: 0.13 } },
      where: { temporalWorkflowId: 'wf-1' },
    });
  });

  it('records a runless workflow with a null runId', async () => {
    activity.inActivity = true;
    runFindUniqueMock.mockResolvedValue(null);
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0), usage: { tokens: 10 } });

    await generateEmbedding('x');

    expect(traceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ runId: null, workflowId: 'wf-1' }),
    });
  });

  it('attributes the row to the spend owner the activity declared', async () => {
    activity.inActivity = true;
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0), usage: { tokens: 10 } });

    await withSpendOwner(Promise.resolve({ orgId: 'org-1', teamId: 'team-1' }), () =>
      generateEmbedding('x')
    );

    expect(traceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: 'org-1', teamId: 'team-1' }),
    });
  });

  it('records null tokens and cost when the provider reports no usage', async () => {
    activity.inActivity = true;
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0), usage: { tokens: NaN } });

    await generateEmbedding('x');

    expect(traceCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ costUsd: null, inputTokens: null, outputTokens: null }),
    });
    expect(ledgerUpdateManyMock).not.toHaveBeenCalled();
  });

  it('writes nothing outside an activity', async () => {
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0), usage: { tokens: 10 } });

    await generateEmbedding('x');

    expect(traceCreateMock).not.toHaveBeenCalled();
  });

  it('still returns the vector when bookkeeping fails', async () => {
    activity.inActivity = true;
    traceCreateMock.mockRejectedValue(new Error('db down'));
    embedMock.mockResolvedValue({ embedding: new Array(1536).fill(0), usage: { tokens: 10 } });

    await expect(generateEmbedding('x')).resolves.toHaveLength(1536);
  });
});
