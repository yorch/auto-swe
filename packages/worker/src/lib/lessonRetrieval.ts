import { resolveSetting } from '@auto-swe/shared/config';
import type { LessonSummary } from '@auto-swe/shared/types/workflow';
import { withoutFlaggedMemory } from './memoryGuard.js';
import { searchMemoryItemsByVector } from './memoryStore.js';
import { ownerOfConnection } from './spendOwner.js';

interface RetrievedLesson {
  id: string;
  lessonSummary: string;
  failureType: string | null;
  similarity: number;
  createdAt: Date;
  confidence: number | null;
}

/**
 * `memory.lessonMaxAgeDays` for a repository's lessons: past it a lesson is no
 * longer recalled or consolidated. Resolved at the repository's owning team and
 * its organization, because lessons belong to the repository, not to whichever
 * run reads them — so recall, `searchLessons` and consolidation agree. 0 is off.
 */
export async function lessonMaxAgeDays(repoId: string): Promise<number> {
  return resolveSetting('memory.lessonMaxAgeDays', await ownerOfConnection(repoId));
}

/**
 * Retrieves lessons from the memory_items table that are semantically similar
 * to the given query text, scoped to a specific repository.
 *
 * Uses pgvector cosine distance for similarity ranking (via the shared
 * {@link searchMemoryItemsByVector} helper). A lesson older than
 * {@link lessonMaxAgeDays} is left out by the query itself, so `limit` still
 * counts only lessons that may be recalled.
 */
export async function retrieveSimilarLessons(
  queryText: string,
  repoId: string,
  limit: number = 5,
  similarityThreshold: number = 0.7
): Promise<LessonSummary[]> {
  const lessons = (await searchMemoryItemsByVector({
    limit,
    maxAgeDays: await lessonMaxAgeDays(repoId),
    queryText,
    scopeColumn: 'repo_id',
    scopeId: repoId,
    selectColumns: [
      'id',
      'lesson_summary AS "lessonSummary"',
      'failure_type AS "failureType"',
      'confidence',
      'created_at AS "createdAt"',
    ],
    similarityThreshold,
  })) as unknown as RetrievedLesson[];

  // A row stored before the write gate, or edited since, is filtered here too:
  // these go straight into the implementer's system prompt.
  const allowed = await withoutFlaggedMemory(lessons, (l) => l.lessonSummary, {
    idOf: (l) => l.id,
  });
  return allowed.map((l) => ({
    confidence: l.confidence ?? null,
    failureType: l.failureType,
    lessonId: l.id,
    similarity: l.similarity,
    summary: l.lessonSummary,
  }));
}
