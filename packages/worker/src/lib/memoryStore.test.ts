import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryRawUnsafeMock, executeRawUnsafeMock, generateEmbeddingWithSpecMock } = vi.hoisted(
  () => ({
    executeRawUnsafeMock: vi.fn(),
    generateEmbeddingWithSpecMock: vi.fn(),
    queryRawUnsafeMock: vi.fn(),
  })
);

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    $executeRawUnsafe: executeRawUnsafeMock,
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

vi.mock('./embeddings.js', () => ({
  generateEmbeddingWithSpec: generateEmbeddingWithSpecMock,
}));

import { insertMemoryItem, reembedMemoryItem, searchMemoryItemsByEntity } from './memoryStore.js';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset().mockResolvedValue(1);
  generateEmbeddingWithSpecMock.mockReset();
});

describe('reembedMemoryItem', () => {
  it('reads the current summary, embeds it, and issues the UPDATE', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ lessonSummary: 'updated summary text' }]);
    const embedding = new Array(1536).fill(0.25);
    generateEmbeddingWithSpecMock.mockResolvedValue({
      embedding,
      spec: 'openai/text-embedding-3-large',
    });

    const result = await reembedMemoryItem('mem-1');

    expect(result).toBe(true);

    // Reads the scalar lesson_summary for the row id (no embedding column projected).
    const selectSql = queryRawUnsafeMock.mock.calls[0][0] as string;
    expect(selectSql).toContain('lesson_summary AS "lessonSummary"');
    expect(selectSql).not.toContain('embedding');
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe('mem-1');

    // Embeds the summary that was just read.
    expect(generateEmbeddingWithSpecMock).toHaveBeenCalledWith('updated summary text');

    // Writes the regenerated vector + spec back to the same row.
    const [updateSql, embedArg, specArg, idArg] = executeRawUnsafeMock.mock.calls[0];
    expect(updateSql).toMatch(/UPDATE memory_items/);
    expect(updateSql).toMatch(/SET embedding = \$1::vector, embedding_model = \$2/);
    expect(updateSql).toMatch(/WHERE id = \$3::uuid/);
    expect(embedArg).toBe(JSON.stringify(embedding));
    expect(specArg).toBe('openai/text-embedding-3-large');
    expect(idArg).toBe('mem-1');
  });

  it('returns false (no throw, no embed, no update) when the row is missing', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    const result = await reembedMemoryItem('missing-id');

    expect(result).toBe(false);
    expect(generateEmbeddingWithSpecMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('insertMemoryItem', () => {
  it('writes a repo-scoped lesson and derives entity_type/entity_id from repoId', async () => {
    const embedding = new Array(1536).fill(0.1);
    generateEmbeddingWithSpecMock.mockResolvedValue({ embedding, spec: 'spec/1' });
    queryRawUnsafeMock.mockResolvedValue([{ id: 'mem-1' }]);

    const id = await insertMemoryItem({
      lessonSummary: 'lesson',
      rationale: 'because',
      repoId: 'repo-uuid',
    });

    expect(id).toBe('mem-1');
    expect(generateEmbeddingWithSpecMock).toHaveBeenCalledWith('lesson');

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('entity_type');
    expect(sql).toContain('entity_id');

    const entityTypeIndex = (sql as string).split(',').findIndex((s) => s.includes('entity_type'));
    const entityIdIndex = (sql as string).split(',').findIndex((s) => s.includes('entity_id'));
    expect(entityTypeIndex).toBeGreaterThan(-1);
    expect(entityIdIndex).toBeGreaterThan(-1);

    // The VALUES clause uses $18 for entity_type and $19 for entity_id.
    expect(params[17]).toBe('connection');
    expect(params[18]).toBe('repo-uuid');
  });

  it('writes an explicit document-scoped entity', async () => {
    const embedding = new Array(1536).fill(0.2);
    generateEmbeddingWithSpecMock.mockResolvedValue({ embedding, spec: 'spec/2' });
    queryRawUnsafeMock.mockResolvedValue([{ id: 'mem-2' }]);

    await insertMemoryItem({
      entityId: 'doc-uuid',
      entityType: 'document',
      lessonSummary: 'doc lesson',
      rationale: 'because doc',
    });

    const [, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(params[17]).toBe('document');
    expect(params[18]).toBe('doc-uuid');
  });
});

describe('searchMemoryItemsByEntity', () => {
  it('searches by entity_type and entity_id', async () => {
    const embedding = new Array(1536).fill(0.3);
    generateEmbeddingWithSpecMock.mockResolvedValue({ embedding, spec: 'spec/3' });
    queryRawUnsafeMock.mockResolvedValue([]);

    await searchMemoryItemsByEntity({
      entityId: 'ent-1',
      entityType: 'project',
      limit: 5,
      queryText: 'q',
      selectColumns: ['lesson_summary AS "lessonSummary"'],
      similarityThreshold: 0.5,
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('entity_type = $2');
    expect(sql).toContain('entity_id = $3');
    expect(params[1]).toBe('project');
    expect(params[2]).toBe('ent-1');
  });
});
