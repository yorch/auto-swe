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

import { reembedMemoryItem } from './memoryStore.js';

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
