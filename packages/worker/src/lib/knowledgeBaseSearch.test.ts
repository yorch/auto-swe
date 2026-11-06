import { resolveSetting } from '@auto-swe/shared/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  governed: vi.fn(),
  model: vi.fn(),
  query: vi.fn(),
  rows: vi.fn(),
  scan: vi.fn(),
  scope: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { $queryRaw: mocks.query, knowledgeBaseChunk: { findMany: mocks.rows } },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => 5) }));
vi.mock('./embeddings.js', () => ({
  currentEmbeddingSpec: mocks.model,
  generateEmbeddingWithSpec: mocks.embed,
}));
vi.mock('./knowledgeRuntime.js', () => ({
  resolveKnowledgeExecutionScope: mocks.scope,
  searchWorkflowKnowledge: mocks.governed,
}));
vi.mock('./memoryGuard.js', () => ({ withoutFlaggedMemory: mocks.scan }));
vi.mock('./activityLog.js', () => ({ logWarn: mocks.warn }));

import { searchKnowledgeBaseChunks, searchRunKnowledge } from './knowledgeBaseSearch.js';

const chunk = (id = 'one', extra = {}) => ({
  content: 'Reference about parser',
  embeddingModel: 'openai/test',
  heading: 'Parsing',
  id,
  path: 'docs/parser.md',
  snapshot: {
    knowledgeBase: { connection: { organizationName: 'acme', repoName: 'reference' } },
    sha: 'a'.repeat(40),
  },
  snapshotId: 'pin-a',
  ...extra,
});
const governed = {
  citation: 'knowledge:governed:v1',
  content: 'Governed parser facts',
  id: 'governed',
  similarity: 0.7,
  title: 'Parser',
  trustLabel: 'REVIEWED',
  type: 'FACT',
  version: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveSetting).mockResolvedValue(5);
  mocks.model.mockResolvedValue('openai/test');
  mocks.embed.mockResolvedValue({ embedding: [0.1, 0.2], spec: 'openai/test' });
  mocks.query.mockResolvedValue([{ id: 'one', similarity: 0.9 }]);
  mocks.rows.mockResolvedValue([chunk()]);
  mocks.scan.mockImplementation(async (rows, textOf) =>
    rows.filter((row: ReturnType<typeof chunk>) => !textOf(row).includes('PLANTED'))
  );
  mocks.governed.mockResolvedValue({ mode: 'semantic', results: [governed] });
  mocks.scope.mockResolvedValue({
    principal: { orgId: 'org', repoId: 'primary-repo', teamId: 'team' },
    sourceAuthorized: true,
  });
});

describe('snapshot-scoped knowledge base search', () => {
  it('falls back to text when compatible vectors are absent, keeping unembedded snapshots searchable', async () => {
    mocks.query.mockResolvedValue([]);
    mocks.rows.mockResolvedValue([chunk('one', { embeddingModel: null })]);
    const result = await searchKnowledgeBaseChunks('parser', ['pin-a']);
    expect(result.mode).toBe('text');
    expect(result.results).toHaveLength(1);
    expect(mocks.rows.mock.calls[0][0].where).not.toHaveProperty('embeddingModel');
  });
  it('ranks cosine vectors scoped to snapshot ids and the configured model', async () => {
    const result = await searchKnowledgeBaseChunks('parser', ['pin-a']);
    expect(result).toMatchObject({
      injectionDropped: 0,
      mode: 'semantic',
      results: [
        {
          citation: 'kb:acme/reference@aaaaaaa docs/parser.md # Parsing',
          similarity: 0.9,
          sourceKind: 'knowledge_base',
          trustLabel: 'UNTRUSTED_THIRD_PARTY_REFERENCE',
        },
      ],
    });
    const sql = mocks.query.mock.calls[0][0];
    expect(sql.sql).toContain('snapshot_id IN');
    expect(sql.sql).toContain('embedding_model =');
    expect(sql.sql).toContain('<=>');
    expect(sql.values).toContain('pin-a');
    expect(sql.values).toContain('openai/test');
    expect(mocks.rows).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 5,
        where: expect.objectContaining({
          embeddingModel: 'openai/test',
          snapshot: { status: 'READY' },
          snapshotId: { in: ['pin-a'] },
        }),
      })
    );
  });
  it('does not return model-mismatched or unranked chunks', async () => {
    mocks.rows.mockResolvedValue([
      chunk('one', { embeddingModel: 'other/model' }),
      chunk('unranked'),
    ]);
    expect((await searchKnowledgeBaseChunks('parser', ['pin-a'])).results).toEqual([]);
  });
  it('does not leak chunks from another run snapshot', async () => {
    mocks.rows.mockResolvedValue([chunk('one', { snapshotId: 'pin-other-run' })]);
    expect((await searchKnowledgeBaseChunks('parser', ['pin-a'])).results).toEqual([]);
    expect(mocks.scan).toHaveBeenCalledWith([], expect.any(Function), expect.any(Object));
  });
  it.each(['embedding', 'configuration', 'sql'])(
    'uses bounded text matching when %s fails',
    async (failure) => {
      if (failure === 'embedding') {
        mocks.embed.mockRejectedValue(new Error('offline'));
      }
      if (failure === 'configuration') {
        mocks.embed.mockResolvedValue({ embedding: [1], spec: 'changed' });
      }
      if (failure === 'sql') {
        mocks.query.mockRejectedValue(new Error('vector unavailable'));
      }
      const result = await searchKnowledgeBaseChunks('parser', ['pin-a'], 2);
      expect(result.mode).toBe('text');
      expect(result.results[0]).not.toHaveProperty('similarity');
      expect(mocks.rows.mock.calls[0][0]).toMatchObject({
        take: 2,
        where: { OR: expect.any(Array), snapshotId: { in: ['pin-a'] } },
      });
    }
  );
  it('scans full content before truncating it, drops injections and counts without exposing ids', async () => {
    mocks.rows.mockResolvedValue([chunk('one', { content: `${'x'.repeat(1700)}PLANTED` })]);
    expect(await searchKnowledgeBaseChunks('parser', ['pin-a'])).toMatchObject({
      injectionDropped: 1,
      results: [],
    });
    expect(mocks.scan.mock.calls[0][2]).toMatchObject({ recordIds: false });
  });
  it('bounds content and sanitizes citation metadata', async () => {
    mocks.rows.mockResolvedValue([
      chunk('one', { content: 'x'.repeat(5000), heading: null, path: 'docs/\nfile' }),
    ]);
    const result = await searchKnowledgeBaseChunks('parser', ['pin-a']);
    expect(result.results[0].content).toHaveLength(1600);
    expect(result.results[0].citation).toBe('kb:acme/reference@aaaaaaa docs/ file');
  });
  it('skips all queries without snapshots', async () => {
    expect(await searchKnowledgeBaseChunks('parser', [])).toMatchObject({
      injectionDropped: 0,
      results: [],
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.rows).not.toHaveBeenCalled();
  });
  it.each([0, 11, 1.5])('rejects invalid result limit %s', async (limit) => {
    await expect(searchKnowledgeBaseChunks('parser', ['pin-a'], limit)).rejects.toThrow(RangeError);
  });
  it('rejects unbounded queries and snapshot sets', async () => {
    await expect(searchKnowledgeBaseChunks(' ', ['pin-a'])).rejects.toThrow(RangeError);
    await expect(searchKnowledgeBaseChunks('x'.repeat(2001), ['pin-a'])).rejects.toThrow(
      RangeError
    );
    await expect(searchKnowledgeBaseChunks('parser', Array(5).fill('pin-a'))).rejects.toThrow(
      RangeError
    );
  });
});

describe('merged run knowledge', () => {
  it('uses the scoped configured default result limit', async () => {
    vi.mocked(resolveSetting).mockResolvedValue(1);
    const result = await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] });
    expect(result.results).toHaveLength(1);
    expect(mocks.rows.mock.calls[0][0].take).toBe(1);
    expect(resolveSetting).toHaveBeenCalledWith('memory.knowledgeMaxResults', {
      orgId: 'org',
      teamId: 'team',
    });
  });
  it('merges by similarity with additive source kinds and citations', async () => {
    const result = await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] });
    expect(result.results.map((row) => row.id)).toEqual(['one', 'governed']);
    expect(result.results[1]).toMatchObject({
      citation: 'knowledge:governed:v1',
      sourceKind: 'governed',
    });
  });
  it('honors the merged limit and configured default', async () => {
    expect(
      (await searchRunKnowledge('parser', { limit: 1, snapshotIds: ['pin-a'] })).results
    ).toHaveLength(1);
    expect(mocks.rows.mock.calls[0][0].take).toBe(1);
  });
  it('reports text mode for a text fallback and sorts semantic hits ahead of text hits', async () => {
    mocks.embed.mockRejectedValue(new Error('offline'));
    const result = await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] });
    expect(result.mode).toBe('text');
    expect(result.results.map((row) => row.id)).toEqual(['governed', 'one']);
  });
  it('does not query KBs for an opted-out step', async () => {
    expect((await searchRunKnowledge('parser', { snapshotIds: [] })).results).toEqual([governed]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('keeps governed hits first on text-mode ties', async () => {
    const { similarity: _similarity, ...textGoverned } = governed;
    mocks.governed.mockResolvedValue({ mode: 'text', results: [textGoverned] });
    mocks.embed.mockRejectedValue(new Error('offline'));
    expect(
      (await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] })).results.map((row) => row.id)
    ).toEqual(['governed', 'one']);
  });
  it('enforces one combined character budget', async () => {
    mocks.governed.mockResolvedValue({
      mode: 'semantic',
      results: Array.from({ length: 5 }, (_, i) => ({
        ...governed,
        content: 'x'.repeat(1600),
        id: `gov-${i}`,
      })),
    });
    mocks.query.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ id: `kb-${i}`, similarity: 0.9 }))
    );
    mocks.rows.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => chunk(`kb-${i}`, { content: 'x'.repeat(1600) }))
    );
    const result = await searchRunKnowledge('parser', { limit: 10, snapshotIds: ['pin-a'] });
    expect(
      result.results.reduce(
        (used, row) => used + row.title.length + row.content.length + row.citation.length,
        0
      )
    ).toBeLessThanOrEqual(8000);
  });
  it('does not expose KBs when the source repository is no longer authorized', async () => {
    mocks.scope.mockResolvedValue({
      principal: { repoId: 'primary-repo' },
      sourceAuthorized: false,
    });
    expect((await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] })).results).toEqual([
      governed,
    ]);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('keeps verified repo-less team runs eligible for their pinned KB references', async () => {
    mocks.scope.mockResolvedValue({
      principal: { orgId: 'org', repoId: null, teamId: 'team' },
      sourceAuthorized: false,
    });
    const result = await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] });
    expect(result.results.map((row) => row.id)).toContain('one');
  });
  it('keeps governed results when optional KB search fails', async () => {
    mocks.rows.mockRejectedValue(new Error('database unavailable'));
    expect((await searchRunKnowledge('parser', { snapshotIds: ['pin-a'] })).results).toEqual([
      governed,
    ]);
    expect(mocks.warn).toHaveBeenCalled();
  });
});
