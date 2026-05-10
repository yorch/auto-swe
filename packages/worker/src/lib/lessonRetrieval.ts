import { prisma } from '@auto-swe/shared/db';
import type { LessonSummary } from '@auto-swe/shared/types/workflow';
import { generateEmbedding } from './embeddings.js';

interface RetrievedLesson {
  id: string;
  lessonSummary: string;
  failureType: string | null;
  similarity: number;
  createdAt: Date;
}

/**
 * Retrieves lessons from the agent_lessons table that are semantically similar
 * to the given query text, scoped to a specific repository.
 *
 * Uses pgvector cosine distance for similarity ranking.
 */
export async function retrieveSimilarLessons(
  queryText: string,
  repoId: string,
  limit: number = 5,
  similarityThreshold: number = 0.7
): Promise<LessonSummary[]> {
  const queryEmbedding = await generateEmbedding(queryText);

  // pgvector cosine distance: 1 - cosine_similarity
  // Lower distance = higher similarity
  const lessons = await prisma.$queryRawUnsafe<RetrievedLesson[]>(
    `SELECT
      id,
      lesson_summary AS "lessonSummary",
      failure_type AS "failureType",
      1 - (embedding <=> $1::vector) AS similarity,
      created_at AS "createdAt"
    FROM agent_lessons
    WHERE repo_id = $2::uuid
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> $1::vector) >= $3
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $4`,
    JSON.stringify(queryEmbedding),
    repoId,
    similarityThreshold,
    limit
  );

  return lessons.map((l) => ({
    failureType: l.failureType,
    lessonId: l.id,
    similarity: l.similarity,
    summary: l.lessonSummary,
  }));
}
