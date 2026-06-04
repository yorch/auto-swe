import { prisma } from '@auto-swe/shared/db';
import type {
  ConsolidateLessonsInput,
  ConsolidateLessonsResult,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { LESSON_CONSOLIDATOR_PROMPT } from '../agents/prompts.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { generateEmbedding } from '../lib/embeddings.js';
import { getModel } from '../lib/models.js';

export type { ConsolidateLessonsInput, ConsolidateLessonsResult };

const ConsolidatedLessonSchema = z.object({
  failureType: z
    .enum(['CI_FAILURE', 'REVIEW_REJECTION', 'SECURITY_VIOLATION', 'MERGE_CONFLICT'])
    .nullable(),
  lessonSummary: z.string(),
  rationale: z.string(),
});

const ConsolidatorOutputSchema = z.object({
  lessons: z.array(ConsolidatedLessonSchema).min(1).max(2),
});

interface RawLesson {
  id: string;
  lessonSummary: string;
  failureType: string | null;
  rationale: string;
  embeddingJson: string | null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-linkage clustering.
 * Returns a list of clusters, each as a list of lesson indices.
 */
function clusterByEmbedding(embeddings: (number[] | null)[], threshold: number): number[][] {
  const n = embeddings.length;
  const assigned = new Uint8Array(n);
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (assigned[i] || !embeddings[i]) {
      continue;
    }
    const cluster = [i];
    assigned[i] = 1;
    for (let j = i + 1; j < n; j++) {
      if (assigned[j] || !embeddings[j]) {
        continue;
      }
      const ei = embeddings[i];
      const ej = embeddings[j];
      if (ei && ej && cosineSimilarity(ei, ej) >= threshold) {
        cluster.push(j);
        assigned[j] = 1;
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Consolidates semantically similar lessons for a repository.
 *
 * Clusters active (non-consolidated) lessons by cosine similarity, then calls
 * an LLM to synthesize each qualifying cluster into one or two generalised
 * lessons. Source lessons are soft-deleted (consolidated_at = now()); the new
 * consolidated rows carry provenance in their metadata.
 */
export async function consolidateLessons(
  input: ConsolidateLessonsInput
): Promise<ConsolidateLessonsResult> {
  const { repoId, minClusterSize = 3, similarityThreshold = 0.85 } = input;

  // Fetch all active lessons with their raw embeddings.
  // Prisma cannot model vector columns, so we use raw SQL.
  const rows = await prisma.$queryRawUnsafe<RawLesson[]>(
    `SELECT
       id,
       lesson_summary   AS "lessonSummary",
       failure_type     AS "failureType",
       rationale,
       embedding::text  AS "embeddingJson"
     FROM agent_lessons
     WHERE repo_id = $1::uuid
       AND consolidated_at IS NULL
     ORDER BY created_at DESC`,
    repoId
  );

  if (rows.length < minClusterSize) {
    return { clustersConsolidated: 0, clustersFound: 0, lessonsConsolidated: 0, lessonsCreated: 0 };
  }

  // Parse stored vector strings "[0.1,0.2,...]" into number arrays.
  const embeddings: (number[] | null)[] = rows.map((r) => {
    if (!r.embeddingJson) {
      return null;
    }
    try {
      return JSON.parse(r.embeddingJson) as number[];
    } catch {
      return null;
    }
  });

  const clusters = clusterByEmbedding(embeddings, similarityThreshold);
  const qualifying = clusters.filter((c) => c.length >= minClusterSize);

  if (qualifying.length === 0) {
    return {
      clustersConsolidated: 0,
      clustersFound: clusters.length,
      lessonsConsolidated: 0,
      lessonsCreated: 0,
    };
  }

  const agent = new Agent({
    id: 'lesson-consolidator',
    instructions: LESSON_CONSOLIDATOR_PROMPT,
    model: await getModel('commitToMemory'),
    name: 'lesson-consolidator',
  });

  let totalConsolidated = 0;
  let totalCreated = 0;
  const tracer = new AgentTracer();

  for (const cluster of qualifying) {
    const clusterLessons = cluster.map((idx) => rows[idx]);
    const sourceIds = clusterLessons.map((l) => l.id);

    const prompt = clusterLessons
      .map(
        (l, i) =>
          `Lesson ${i + 1} [${l.failureType ?? 'GENERAL'}]:\n` +
          `Rationale: ${l.rationale}\n` +
          `Summary: ${l.lessonSummary}`
      )
      .join('\n\n');

    const start = Date.now();
    const result = await agent.generate([{ content: prompt, role: 'user' }], {
      structuredOutput: { schema: ConsolidatorOutputSchema },
    });

    if (result.usage) {
      await recordLlmUsage(
        'consolidateLessons',
        'commitToMemory',
        result.usage,
        'llm.consolidate_lessons'
      );
    }

    if (!result.object) {
      continue;
    }
    const { lessons } = result.object as z.infer<typeof ConsolidatorOutputSchema>;

    tracer.addLlmResponse({
      durationMs: Date.now() - start,
      outputJson: { lessonsOut: lessons.length, sourceIds },
      role: 'commitToMemory',
    });

    // Determine dominant failureType across the cluster (null if mixed).
    const types = [...new Set(clusterLessons.map((l) => l.failureType))];
    const sharedFailureType = types.length === 1 ? types[0] : null;

    // Write new consolidated lessons then soft-delete sources in a transaction.
    await prisma.$transaction(async (tx) => {
      for (const lesson of lessons) {
        const embedding = await generateEmbedding(lesson.lessonSummary);
        await tx.$executeRawUnsafe(
          `INSERT INTO agent_lessons
             (id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
           VALUES
             (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, $5, $6::jsonb, now())`,
          repoId,
          lesson.rationale,
          lesson.lessonSummary,
          JSON.stringify(embedding),
          lesson.failureType ?? sharedFailureType,
          JSON.stringify({ clusterSize: cluster.length, consolidatedFrom: sourceIds })
        );
        totalCreated++;
      }

      // Soft-delete source rows.
      await tx.$executeRawUnsafe(
        `UPDATE agent_lessons SET consolidated_at = now() WHERE id = ANY($1::uuid[])`,
        sourceIds
      );
    });

    totalConsolidated += cluster.length;
  }

  tracer.addActivityEvent({
    name: 'lessons.consolidated',
    outputJson: {
      clustersConsolidated: qualifying.length,
      lessonsConsolidated: totalConsolidated,
      lessonsCreated: totalCreated,
    },
  });

  return {
    clustersConsolidated: qualifying.length,
    clustersFound: clusters.length,
    lessonsConsolidated: totalConsolidated,
    lessonsCreated: totalCreated,
  };
}
