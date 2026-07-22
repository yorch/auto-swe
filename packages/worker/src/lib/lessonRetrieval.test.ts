import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./memoryStore.js', () => ({
  searchMemoryItemsByVector: vi.fn().mockResolvedValue([]),
}));

import { retrieveSimilarLessons } from './lessonRetrieval.js';
import { searchMemoryItemsByVector } from './memoryStore.js';

const mockSearch = vi.mocked(searchMemoryItemsByVector);

describe('retrieveSimilarLessons', () => {
  beforeEach(() => {
    mockSearch.mockClear();
  });

  it('forwards the caller-supplied limit + threshold to the vector search', async () => {
    // The caller (executeImplementation) passes DB-backed
    // resolveWorkflowDefaults().lessonRetrievalLimit / lessonRetrievalThreshold;
    // assert those values reach the query rather than the literal defaults.
    await retrieveSimilarLessons('add health endpoint', 'repo-1', 9, 0.9);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 9, scopeId: 'repo-1', similarityThreshold: 0.9 })
    );
  });

  it('falls back to the literal 5 / 0.7 defaults when the caller omits them', async () => {
    await retrieveSimilarLessons('add health endpoint', 'repo-1');

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, similarityThreshold: 0.7 })
    );
  });
});
