import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
    agent: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveConsolidationConfig: vi.fn().mockResolvedValue({
    cronExpression: '0 3 * * 0',
    enabled: true,
    minClusterSize: 3,
    similarityThreshold: 0.85,
  }),
}));
vi.mock('../lib/embeddings.js', () => ({
  currentEmbeddingSpec: vi.fn(async () => 'openai/text-embedding-3-large'),
  generateEmbedding: vi.fn(),
  generateEmbeddingWithSpec: vi.fn(async () => ({
    embedding: [],
    spec: 'openai/text-embedding-3-large',
  })),
}));
vi.mock('../lib/models.js', () => ({
  getModel: vi.fn(),
  resolveSystemPrompt: vi.fn().mockResolvedValue(''),
}));
vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi.fn(),
}));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn() }));
vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.addActivityEvent = vi.fn();
    this.addLlmResponse = vi.fn();
    this.persist = vi.fn();
  }),
}));

// The generate fn is declared here so the Agent constructor closure captures it.
// Tests configure it via mockGenerate.mockResolvedValue(...).
const mockGenerate = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.generate = mockGenerate;
  }),
}));

import { prisma } from '@auto-swe/shared/db';
import { resolveConsolidationConfig } from '@auto-swe/shared/lib/systemConfig';
import { Agent } from '@mastra/core/agent';
import { generateEmbedding } from '../lib/embeddings.js';
import { getModel } from '../lib/models.js';
import { consolidateLessons } from './consolidateLessons.js';

const mockQueryRaw = vi.mocked(prisma.$queryRawUnsafe);
const mockTransaction = vi.mocked(prisma.$transaction);
const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockGetModel = vi.mocked(getModel);
const mockResolveConsolidationConfig = vi.mocked(resolveConsolidationConfig);
const MockAgent = vi.mocked(Agent);

// Unit vectors for predictable cosine similarity: same seed = similarity 1, different seed = 0.
function makeEmbedding(seed: number): number[] {
  const v = new Array(1536).fill(0);
  v[seed % 1536] = 1;
  return v;
}

function makeLessonRow(
  id: string,
  summary: string,
  embeddingSeed: number,
  failureType: string | null = null
) {
  return {
    embeddingJson: JSON.stringify(makeEmbedding(embeddingSeed)),
    failureType,
    id,
    lessonSummary: summary,
    rationale: `Rationale for ${id}`,
  };
}

function makeSuccessGenerate(
  lessons = [
    {
      failureType: null as string | null,
      lessonSummary: 'consolidated lesson',
      rationale: 'reason',
    },
  ]
) {
  return mockGenerate.mockResolvedValue({ object: { lessons }, usage: null });
}

const defaultTxMock = {
  $executeRawUnsafe: vi.fn(),
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(async () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetModel.mockResolvedValue({} as never);
  mockGenerateEmbedding.mockResolvedValue(makeEmbedding(0));
  mockTransaction.mockImplementation(async (fn) => fn(defaultTxMock as never));
});

describe('consolidateLessons', () => {
  it('returns zeros when fewer rows than minClusterSize exist', async () => {
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'lesson a', 0),
      makeLessonRow('b', 'lesson b', 1),
    ]);

    const result = await consolidateLessons({ minClusterSize: 3, repoId: 'repo-1' });

    expect(result).toEqual({
      clustersConsolidated: 0,
      clustersFound: 0,
      lessonsConsolidated: 0,
      lessonsCreated: 0,
    });
    expect(MockAgent).not.toHaveBeenCalled();
  });

  it('returns zeros when no cluster meets minClusterSize', async () => {
    // Three rows each with different embeddings — every cluster has size 1
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'lesson a', 0),
      makeLessonRow('b', 'lesson b', 1),
      makeLessonRow('c', 'lesson c', 2),
    ]);

    const result = await consolidateLessons({
      minClusterSize: 3,
      repoId: 'repo-1',
      similarityThreshold: 0.99,
    });

    expect(result.clustersConsolidated).toBe(0);
    expect(result.lessonsConsolidated).toBe(0);
    expect(MockAgent).not.toHaveBeenCalled();
  });

  it('consolidates a cluster of identical-embedding lessons', async () => {
    // Three lessons with the same embedding seed — cosine similarity = 1
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'Always run db migrate before deploy', 0, 'CI_FAILURE'),
      makeLessonRow('b', 'Run db migrate before deploying', 0, 'CI_FAILURE'),
      makeLessonRow('c', 'DB migrations must precede deploy', 0, 'CI_FAILURE'),
    ]);
    makeSuccessGenerate([
      {
        failureType: 'CI_FAILURE',
        lessonSummary: 'Always run database migrations before deploying.',
        rationale: 'Three CI failures share this root cause.',
      },
    ]);

    const result = await consolidateLessons({
      minClusterSize: 3,
      repoId: 'repo-1',
      similarityThreshold: 0.85,
    });

    expect(result.clustersFound).toBe(1);
    expect(result.clustersConsolidated).toBe(1);
    expect(result.lessonsConsolidated).toBe(3);
    expect(result.lessonsCreated).toBe(1);
    expect(mockGenerate).toHaveBeenCalledOnce();
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it('skips clusters smaller than minClusterSize', async () => {
    // Cluster of 2 (same seed) + singleton — both below minClusterSize=3
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'lesson a', 0),
      makeLessonRow('b', 'lesson b', 0),
      makeLessonRow('c', 'lesson c', 5),
    ]);

    const result = await consolidateLessons({
      minClusterSize: 3,
      repoId: 'repo-1',
      similarityThreshold: 0.99,
    });

    expect(result.clustersConsolidated).toBe(0);
    expect(result.lessonsConsolidated).toBe(0);
    expect(MockAgent).not.toHaveBeenCalled();
  });

  it('skips rows with null embeddings during clustering', async () => {
    // Row 'a' has no embedding — b, c, d cluster together (seed 0, size 3)
    mockQueryRaw.mockResolvedValue([
      { ...makeLessonRow('a', 'lesson a', 0), embeddingJson: null },
      makeLessonRow('b', 'lesson b', 0),
      makeLessonRow('c', 'lesson c', 0),
      makeLessonRow('d', 'lesson d', 0),
    ]);
    makeSuccessGenerate();

    const result = await consolidateLessons({
      minClusterSize: 3,
      repoId: 'repo-1',
      similarityThreshold: 0.99,
    });

    expect(result.clustersConsolidated).toBe(1);
    expect(result.lessonsConsolidated).toBe(3);
  });

  it('uses null failureType when cluster contains mixed failure types', async () => {
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'lesson a', 0, 'CI_FAILURE'),
      makeLessonRow('b', 'lesson b', 0, 'REVIEW_REJECTION'),
      makeLessonRow('c', 'lesson c', 0, null),
    ]);

    let capturedInsertArgs: unknown[] | undefined;
    const mockExecuteRaw = vi.fn().mockImplementation((...args) => {
      if (typeof args[0] === 'string' && (args[0] as string).includes('INSERT')) {
        capturedInsertArgs = args;
      }
    });
    mockTransaction.mockImplementation(async (fn) =>
      fn({ ...defaultTxMock, $executeRawUnsafe: mockExecuteRaw } as never)
    );
    makeSuccessGenerate([{ failureType: null, lessonSummary: 'consolidated', rationale: 'r' }]);

    await consolidateLessons({ minClusterSize: 3, repoId: 'repo-1', similarityThreshold: 0.99 });

    // 7th positional arg to the INSERT is failureType (index 6) — index 5 is
    // the embedding_model spec added by EVOL-4.
    expect(capturedInsertArgs?.[6]).toBeNull();
  });

  it('falls back to resolveConsolidationConfig when input omits overrides', async () => {
    mockResolveConsolidationConfig.mockResolvedValue({
      cronExpression: '0 3 * * 0',
      enabled: true,
      minClusterSize: 2,
      similarityThreshold: 0.5,
    });
    // Two rows with cosine similarity 0.6 (dot([1,0],[0.6,0.8]) = 0.6, both
    // unit vectors): below the 0.85 built-in default threshold they wouldn't
    // cluster, but the resolved 0.5 threshold (and minClusterSize 2) should
    // let them cluster and qualify.
    mockQueryRaw.mockResolvedValue([
      { ...makeLessonRow('a', 'lesson a', 0), embeddingJson: JSON.stringify([1, 0]) },
      { ...makeLessonRow('b', 'lesson b', 0), embeddingJson: JSON.stringify([0.6, 0.8]) },
    ]);
    makeSuccessGenerate();

    const result = await consolidateLessons({ repoId: 'repo-1' });

    expect(mockResolveConsolidationConfig).toHaveBeenCalledOnce();
    expect(result.clustersConsolidated).toBe(1);
    expect(result.lessonsConsolidated).toBe(2);
  });

  it('prefers explicit input overrides over the resolved DB config', async () => {
    mockResolveConsolidationConfig.mockResolvedValue({
      cronExpression: '0 3 * * 0',
      enabled: true,
      minClusterSize: 2,
      similarityThreshold: 0.5,
    });
    // Only 2 rows — below the explicit input minClusterSize of 3, so the
    // resolved DB minClusterSize of 2 must NOT be used.
    mockQueryRaw.mockResolvedValue([
      makeLessonRow('a', 'lesson a', 0),
      makeLessonRow('b', 'lesson b', 0),
    ]);

    const result = await consolidateLessons({
      minClusterSize: 3,
      repoId: 'repo-1',
      similarityThreshold: 0.99,
    });

    expect(result).toEqual({
      clustersConsolidated: 0,
      clustersFound: 0,
      lessonsConsolidated: 0,
      lessonsCreated: 0,
    });
    expect(MockAgent).not.toHaveBeenCalled();
  });
});
