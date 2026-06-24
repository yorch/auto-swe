import type { LessonSummary } from '@auto-swe/shared/types/workflow';
import { searchMemoryItemsByVector } from './memoryStore.js';

interface RetrievedLesson {
  id: string;
  lessonSummary: string;
  failureType: string | null;
  similarity: number;
  createdAt: Date;
}

/**
 * Retrieves lessons from the memory_items table that are semantically similar
 * to the given query text, scoped to a specific repository.
 *
 * Uses pgvector cosine distance for similarity ranking (via the shared
 * {@link searchMemoryItemsByVector} helper).
 */
export async function retrieveSimilarLessons(
  queryText: string,
  repoId: string,
  limit: number = 5,
  similarityThreshold: number = 0.7
): Promise<LessonSummary[]> {
  const lessons = (await searchMemoryItemsByVector({
    limit,
    queryText,
    scopeColumn: 'repo_id',
    scopeId: repoId,
    selectColumns: [
      'id',
      'lesson_summary AS "lessonSummary"',
      'failure_type AS "failureType"',
      'created_at AS "createdAt"',
    ],
    similarityThreshold,
  })) as unknown as RetrievedLesson[];

  return lessons.map((l) => ({
    failureType: l.failureType,
    lessonId: l.id,
    similarity: l.similarity,
    summary: l.lessonSummary,
  }));
}
