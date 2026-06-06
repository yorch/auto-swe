import { prisma } from '@auto-swe/shared/db';
import type {
  ConsolidateLessonsInput,
  ConsolidateLessonsResult,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { LESSON_CONSOLIDATOR_PROMPT } from '../agents/prompts.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
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

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Greedy single-linkage clustering using pre-computed norms.
 * Returns a list of clusters, each as a list of lesson indices.
 */
function clusterByEmbedding(
  embeddings: (number[] | null)[],
  norms: number[],
  threshold: number
): number[][] {
  const n = embeddings.length;
  const assigned = new Uint8Array(n);
  const clusters: number[][] = [];

  for (let i = 0; i < n; i++) {
    if (assigned[i] || !embeddings[i]) {
      continue;
    }
    const cluster = [i];
    assigned[i] = 1;
    const ei = embeddings[i];
    for (let j = i + 1; j < n; j++) {
      const ej = embeddings[j];
      if (!ej || norms[i] === 0 || norms[j] === 0) {
        continue;
      }
      if (ei && dotProduct(ei, ej) / (norms[i] * norms[j]) >= threshold) {
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

  // Pre-compute norms once so the O(N²) inner loop only does dot products.
  const norms = embeddings.map((e) => {
    if (!e) {
      return 0;
    }
    let sum = 0;
    for (const v of e) {
      sum += v * v;
    }
    return Math.sqrt(sum);
  });

  const clusters = clusterByEmbedding(embeddings, norms, similarityThreshold);
  const qualifying = clusters.filter((c) => c.length >= minClusterSize);

  if (qualifying.length === 0) {
    return {
      clustersConsolidated: 0,
      clustersFound: clusters.length,
      lessonsConsolidated: 0,
      lessonsCreated: 0,
    };
  }

  // Load skills for the commitToMemory role (no ctx — consolidateLessons is
  // a scheduled job unbound from any specific workflow run, so GLOBAL scope only).
  const consolidatorSkills = await loadAgentSkills('commitToMemory');
  const consolidatorSkillSuffix = consolidatorSkills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');
  const consolidatorPrompt = consolidatorSkillSuffix
    ? `${LESSON_CONSOLIDATOR_PROMPT}\n\n${consolidatorSkillSuffix}`
    : LESSON_CONSOLIDATOR_PROMPT;

  const agent = new Agent({
    id: 'lesson-consolidator',
    instructions: consolidatorPrompt,
    model: await getModel('commitToMemory'),
    name: 'lesson-consolidator',
  });

  const tracer = new AgentTracer();

  // Process clusters in parallel — each is independent (different source rows, different inserts).
  const clusterOutcomes = await Promise.all(
    qualifying.map(async (cluster) => {
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
        return { consolidated: 0, created: 0 };
      }

      const { lessons } = ConsolidatorOutputSchema.parse(result.object);

      tracer.addLlmResponse({
        durationMs: Date.now() - start,
        outputJson: { lessonsOut: lessons.length, sourceIds },
        role: 'commitToMemory',
      });

      // Determine dominant failureType across the cluster (null if mixed).
      const types = [...new Set(clusterLessons.map((l) => l.failureType))];
      const sharedFailureType = types.length === 1 ? types[0] : null;

      // Generate embeddings before opening the transaction to avoid holding a
      // DB connection open during an external HTTP round-trip.
      const newEmbeddings = await Promise.all(
        lessons.map((l) => generateEmbedding(l.lessonSummary))
      );

      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < lessons.length; i++) {
          const lesson = lessons[i];
          await tx.$executeRawUnsafe(
            `INSERT INTO agent_lessons
               (id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
             VALUES
               (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, $5, $6::jsonb, now())`,
            repoId,
            lesson.rationale,
            lesson.lessonSummary,
            JSON.stringify(newEmbeddings[i]),
            lesson.failureType ?? sharedFailureType,
            JSON.stringify({ clusterSize: cluster.length, consolidatedFrom: sourceIds })
          );
        }

        // Soft-delete source rows.
        await tx.$executeRawUnsafe(
          `UPDATE agent_lessons SET consolidated_at = now() WHERE id = ANY($1::uuid[])`,
          sourceIds
        );
      });

      return { consolidated: cluster.length, created: lessons.length };
    })
  );

  const totalConsolidated = clusterOutcomes.reduce((s, o) => s + o.consolidated, 0);
  const totalCreated = clusterOutcomes.reduce((s, o) => s + o.created, 0);

  const finalResult: ConsolidateLessonsResult = {
    clustersConsolidated: qualifying.length,
    clustersFound: clusters.length,
    lessonsConsolidated: totalConsolidated,
    lessonsCreated: totalCreated,
  };

  tracer.addActivityEvent({ name: 'lessons.consolidated', outputJson: finalResult });
  await persistActivityTrace(tracer, 'commitToMemory');

  return finalResult;
}
