import { prisma } from '@auto-swe/shared/db';
import { resolveConsolidationConfig } from '@auto-swe/shared/lib/systemConfig';
import type {
  ConsolidateLessonsInput,
  ConsolidateLessonsResult,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { LESSON_CONSOLIDATOR_PROMPT } from '../agents/prompts.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { mapWithConcurrency } from '../lib/boundedMap.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { joinSkillPrompts } from '../lib/config/skillPrompt.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { clusterByEmbedding, vectorNorms } from '../lib/embeddingClustering.js';
import { currentEmbeddingSpec, generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { memoryInjectionMatches } from '../lib/memoryGuard.js';
import { getBoundModel, resolveSystemPrompt } from '../lib/models.js';
import { ownerOfConnection, withSpendOwner } from '../lib/spendOwner.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';

const CONSOLIDATOR_AGENT_KEY = 'lessonConsolidator';

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

/**
 * Consolidates semantically similar lessons for a repository.
 *
 * Clusters active (non-consolidated) lessons by cosine similarity, then calls
 * an LLM to synthesize each qualifying cluster into one or two generalised
 * lessons. Source lessons are soft-deleted (consolidated_at = now()); the new
 * consolidated rows carry provenance in their metadata.
 */
/** Max clusters consolidated concurrently — each is one LLM call plus embeddings. */
const CLUSTER_CONCURRENCY = 3;

export async function consolidateLessons(
  input: ConsolidateLessonsInput
): Promise<ConsolidateLessonsResult> {
  // No run row: the spend is the repository's team's.
  return withSpendOwner(ownerOfConnection(input.repoId), () => consolidateLessonsImpl(input));
}

async function consolidateLessonsImpl(
  input: ConsolidateLessonsInput
): Promise<ConsolidateLessonsResult> {
  const { repoId } = input;

  // DB config is the per-run fallback (mirrors `consolidateChannelMemory`'s
  // channel-override ?? input ?? default pattern) — so an admin's config edit
  // applies on the next scheduled fire without re-syncing the Temporal Schedule.
  const resolved = await resolveConsolidationConfig();
  const minClusterSize = input.minClusterSize ?? resolved.minClusterSize;
  const similarityThreshold = input.similarityThreshold ?? resolved.similarityThreshold;

  // Fetch all active lessons with their raw embeddings.
  // Prisma cannot model vector columns, so we use raw SQL.
  // Scope to vectors from the current embedding space (null = legacy rows
  // assumed to share it) — cosine similarity across different embedding
  // models is meaningless and would merge unrelated lessons.
  const embeddingSpec = await currentEmbeddingSpec();
  const rows = await prisma.$queryRawUnsafe<RawLesson[]>(
    `SELECT
       id,
       lesson_summary   AS "lessonSummary",
       failure_type     AS "failureType",
       rationale,
       embedding::text  AS "embeddingJson"
     FROM memory_items
     WHERE repo_id = $1::uuid
       AND consolidated_at IS NULL
       AND (embedding_model IS NULL OR embedding_model = $2)
     ORDER BY created_at DESC`,
    repoId,
    embeddingSpec
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
  const norms = vectorNorms(embeddings);

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

  // The seeded `lessonConsolidator` Agent drives this pass: its prompt, its
  // skills, and its model (inherited from `commitToMemory` unless an admin
  // gives it its own). No ctx — consolidation is a scheduled job unbound from
  // any workflow run, so the GLOBAL row resolves.
  const consolidatorSkills = await loadAgentSkills(CONSOLIDATOR_AGENT_KEY);
  const consolidatorSkillSuffix = joinSkillPrompts(consolidatorSkills);
  const basePrompt = await resolveSystemPrompt(CONSOLIDATOR_AGENT_KEY, LESSON_CONSOLIDATOR_PROMPT);
  const consolidatorPrompt = consolidatorSkillSuffix
    ? `${basePrompt}\n\n${consolidatorSkillSuffix}`
    : basePrompt;

  const bound = await getBoundModel(CONSOLIDATOR_AGENT_KEY);
  const agent = new Agent({
    id: 'lesson-consolidator',
    instructions: consolidatorPrompt,
    model: bound.model,
    name: 'lesson-consolidator',
  });

  const tracer = new AgentTracer();

  try {
    // Clusters are independent (different source rows, different inserts), but
    // each costs one LLM call plus embeddings, so run them through a bounded
    // pool rather than firing every cluster at once on a repo with many.
    const processCluster = async (cluster: number[]) => {
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
      await assertRolePricedForUsdCap(CONSOLIDATOR_AGENT_KEY);
      const result = await agent.generate([{ content: prompt, role: 'user' }], {
        structuredOutput: { schema: ConsolidatorOutputSchema },
      });

      let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
      if (result.usage) {
        attribution = await recordLlmUsage(
          'consolidateLessons',
          CONSOLIDATOR_AGENT_KEY,
          result.usage,
          'llm.consolidate_lessons',
          bound.spec
        );
      }

      if (!result.object) {
        return { consolidated: 0, created: 0 };
      }

      const { lessons } = ConsolidatorOutputSchema.parse(result.object);

      tracer.addLlmResponse({
        costUsd: attribution.costUsd,
        durationMs: Date.now() - start,
        inputJson: { systemPrompt: consolidatorPrompt, userMessage: prompt },
        inputTokens: attribution.inputTokens,
        model: attribution.modelSpec || undefined,
        outputJson: { lessonsOut: lessons.length, sourceIds },
        outputTokens: attribution.outputTokens,
        role: CONSOLIDATOR_AGENT_KEY,
      });

      // Consolidated rows are inserted here rather than through `insertMemoryItem`,
      // so the memory gate is applied here: a merged note that reads as an
      // instruction leaves the cluster as it was. A scan that fails refuses too.
      const refused = await memoryInjectionMatches(
        lessons.flatMap((m) => [m.lessonSummary, m.rationale])
      ).catch(() => ['scan unavailable']);
      if (refused.length > 0) {
        tracer.addActivityEvent({
          name: 'memory.consolidation_refused',
          outputJson: { patterns: refused, sourceIds },
        });
        return { consolidated: 0, created: 0 };
      }

      // Determine dominant failureType across the cluster (null if mixed).
      const types = [...new Set(clusterLessons.map((l) => l.failureType))];
      const sharedFailureType = types.length === 1 ? types[0] : null;

      // Generate embeddings before opening the transaction to avoid holding a
      // DB connection open during an external HTTP round-trip.
      const newEmbeddings = await Promise.all(
        lessons.map((l) => generateEmbeddingWithSpec(l.lessonSummary))
      );

      // The transaction's own result is the outcome: a cluster another run
      // consolidated first returns zeros from inside it.
      return prisma.$transaction(async (tx) => {
        // Serialise consolidation per repo. The read + LLM work happened
        // outside the transaction; re-check that the source rows are still
        // unconsolidated before writing, otherwise an overlapping scheduled
        // run would insert duplicate consolidated lessons.
        // CLAUDE.md §7 exception: transaction-scoped advisory lock (Prisma has no
        // API for it). `$executeRaw` because the lock returns void, which the
        // Prisma 7 driver adapter cannot deserialise as a result column.
        await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(hashtextextended(${repoId}, 0))
          `;
        const stillActive = await tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM memory_items WHERE id = ANY($1::uuid[]) AND consolidated_at IS NULL`,
          sourceIds
        );
        if (stillActive.length < sourceIds.length) {
          return { consolidated: 0, created: 0 };
        }

        for (let i = 0; i < lessons.length; i++) {
          const lesson = lessons[i];
          await tx.$executeRawUnsafe(
            `INSERT INTO memory_items
               (id, repo_id, rationale, lesson_summary, embedding, embedding_model, failure_type, metadata, created_at)
             VALUES
               (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, $5, $6, $7::jsonb, now())`,
            repoId,
            lesson.rationale,
            lesson.lessonSummary,
            JSON.stringify(newEmbeddings[i]?.embedding),
            newEmbeddings[i]?.spec ?? null,
            lesson.failureType ?? sharedFailureType,
            JSON.stringify({ clusterSize: cluster.length, consolidatedFrom: sourceIds })
          );
        }

        // Soft-delete source rows.
        await tx.$executeRawUnsafe(
          `UPDATE memory_items SET consolidated_at = now() WHERE id = ANY($1::uuid[]) AND consolidated_at IS NULL`,
          sourceIds
        );
        return { consolidated: cluster.length, created: lessons.length };
      });
    };
    const clusterOutcomes = await mapWithConcurrency(
      qualifying,
      CLUSTER_CONCURRENCY,
      processCluster
    );

    const totalConsolidated = clusterOutcomes.reduce((s, o) => s + o.consolidated, 0);
    const totalCreated = clusterOutcomes.reduce((s, o) => s + o.created, 0);

    const finalResult: ConsolidateLessonsResult = {
      clustersConsolidated: clusterOutcomes.filter((o) => o.consolidated > 0).length,
      clustersFound: clusters.length,
      lessonsConsolidated: totalConsolidated,
      lessonsCreated: totalCreated,
    };

    tracer.addActivityEvent({ name: 'lessons.consolidated', outputJson: finalResult });

    return finalResult;
  } finally {
    await persistActivityTrace(tracer, CONSOLIDATOR_AGENT_KEY);
  }
}
