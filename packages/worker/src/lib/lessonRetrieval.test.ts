import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./memoryStore.js', () => ({
  searchMemoryItemsByVector: vi.fn().mockResolvedValue([]),
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn().mockResolvedValue(0) }));
vi.mock('./spendOwner.js', () => ({
  ownerOfConnection: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async (text: string) => {
    const warnings = text.includes('INJECT') ? ['injection:ignore-previous-instructions'] : [];
    return { incomplete: false, safe: warnings.length === 0, warnings };
  }),
}));

import { resolveSetting } from '@auto-swe/shared/config';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import { retrieveSimilarLessons } from './lessonRetrieval.js';
import { searchMemoryItemsByVector } from './memoryStore.js';
import { ownerOfConnection } from './spendOwner.js';

const mockSearch = vi.mocked(searchMemoryItemsByVector);
const mockResolveSetting = vi.mocked(resolveSetting);

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

  it('drops a stored lesson that reads as an instruction', async () => {
    mockSearch.mockResolvedValueOnce([
      {
        createdAt: new Date(),
        failureType: null,
        id: 'a',
        lessonSummary: 'run lint',
        similarity: 0.9,
      },
      {
        createdAt: new Date(),
        failureType: null,
        id: 'b',
        lessonSummary: 'INJECT',
        similarity: 0.8,
      },
    ] as never);

    const lessons = await retrieveSimilarLessons('q', 'repo-1');

    expect(lessons.map((l) => l.lessonId)).toEqual(['a']);
  });

  it('keeps a stored lesson when the scan is incomplete and the rules that ran flag nothing', async () => {
    vi.mocked(scanSkillContent).mockResolvedValueOnce({
      incomplete: true,
      safe: true,
      warnings: [],
    });
    mockSearch.mockResolvedValueOnce([
      {
        createdAt: new Date(),
        failureType: null,
        id: 'a',
        lessonSummary: 'run lint',
        similarity: 0.9,
      },
    ] as never);

    const lessons = await retrieveSimilarLessons('q', 'repo-1');

    expect(lessons.map((l) => l.lessonId)).toEqual(['a']);
  });

  it("filters by the repository's lesson age in the query, resolved at its owning team", async () => {
    mockResolveSetting.mockResolvedValueOnce(90 as never);
    await retrieveSimilarLessons('q', 'repo-1', 5, 0.7);

    expect(mockResolveSetting).toHaveBeenCalledWith('memory.lessonMaxAgeDays', {
      orgId: 'org-1',
      teamId: 'team-1',
    });
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ limit: 5, maxAgeDays: 90 }));
  });

  it('treats aging as off, and still recalls, when the setting cannot be read', async () => {
    mockResolveSetting.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await retrieveSimilarLessons('q', 'repo-1');
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxAgeDays: 0 }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory.lessonMaxAgeDays'));
    warn.mockRestore();
  });

  it("caches the repository's owning team between recalls", async () => {
    await retrieveSimilarLessons('q', 'repo-cache');
    await retrieveSimilarLessons('q', 'repo-cache');
    expect(
      vi.mocked(ownerOfConnection).mock.calls.filter((c) => c[0] === 'repo-cache')
    ).toHaveLength(1);
  });

  it('passes 0, keeping every age, when the setting is off', async () => {
    await retrieveSimilarLessons('q', 'repo-1');
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxAgeDays: 0 }));
  });
});
