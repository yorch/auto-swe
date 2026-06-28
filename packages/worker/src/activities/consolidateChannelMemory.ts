import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_MEMORY_CONSOLIDATOR_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { clusterByEmbedding, vectorNorms } from '../lib/embeddingClustering.js';
import { currentEmbeddingSpec, generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { getModel } from '../lib/models.js';
import { accrueChannelUsage, isChannelOverBudgetNow } from './channelAssistant.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConsolidateChannelMemoryInput {
  channelId: string;
  /** Minimum cluster size to trigger synthesis (default 3). */
  minClusterSize?: number;
  /** Cosine-similarity threshold for clustering (default 0.85). */
  similarityThreshold?: number;
}

export interface ConsolidateChannelMemoryResult {
  clustersFound: number;
  clustersConsolidated: number;
  memoriesConsolidated: number;
  memoriesCreated: number;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const ConsolidatedMemoryItemSchema = z.object({
  lessonSummary: z.string(),
  rationale: z.string(),
});

const ConsolidatorOutputSchema = z.object({
  memories: z.array(ConsolidatedMemoryItemSchema).min(1).max(2),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawMemoryItem {
  id: string;
  lessonSummary: string;
  rationale: string;
  embeddingJson: string | null;
  teamId: string | null;
  orgId: string | null;
}

const EMPTY_RESULT: ConsolidateChannelMemoryResult = {
  clustersConsolidated: 0,
  clustersFound: 0,
  memoriesConsolidated: 0,
  memoriesCreated: 0,
};

// ── Activity ─────────────────────────────────────────────────────────────────

/**
 * Channel assistant (Gap F): consolidate semantically similar channel-memory
 * items to prevent the "memory bloat / stale / noisy" failure mode.
 *
 * Mirrors `consolidateLessons` (repo-scoped) but targets the channel memory
 * scope: fetches all un-consolidated `memory_items` for a channel, clusters
 * them by cosine similarity (shared {@link clusterByEmbedding}), synthesises each
 * qualifying cluster into 1–2 durable facts via an LLM, and soft-deletes the
 * originals (`consolidated_at = now()`). The synthesised rows carry provenance
 * metadata.
 *
 * Called from `ChannelAmbientWorkflow` on each ambient fire so the channel's
 * memory stays clean over time. Best-effort by the caller (a failure here
 * must not stop the ambient digest).
 *
 * BUDGET: this pass makes LLM calls, so it honours the channel's monthly budget
 * cap exactly like the digest — when the channel is over budget it returns early
 * without spending (same `isChannelOverBudgetNow` gate the digest uses). Its cost
 * accrues to `ChannelMonthlyUsage` (the per-channel budget) via `accrueChannelUsage`
 * with `countRun: false` — consolidation is maintenance, not a user-facing run, so
 * it must not inflate `runsCompleted`.
 */
export async function consolidateChannelMemory(
  input: ConsolidateChannelMemoryInput
): Promise<ConsolidateChannelMemoryResult> {
  const { channelId, minClusterSize = 3, similarityThreshold = 0.85 } = input;

  // Budget gate: skip consolidation entirely when the channel is over its monthly
  // cap, so an exhausted channel doesn't keep spending on every ambient fire.
  const channel = await prisma.slackChannel.findUnique({
    select: { monthlyBudgetUsdCents: true },
    where: { id: channelId },
  });
  if (await isChannelOverBudgetNow(channelId, channel?.monthlyBudgetUsdCents ?? null)) {
    return EMPTY_RESULT;
  }

  const embeddingSpec = await currentEmbeddingSpec();

  // Fetch all active (non-consolidated) channel memory items with embeddings.
  // Raw SQL because Prisma can't project the pgvector column.
  const rows = await prisma.$queryRawUnsafe<RawMemoryItem[]>(
    `SELECT
       id,
       lesson_summary   AS "lessonSummary",
       rationale,
       embedding::text  AS "embeddingJson",
       team_id          AS "teamId",
       org_id           AS "orgId"
     FROM memory_items
     WHERE channel_id = $1::uuid
       AND consolidated_at IS NULL
       AND (embedding_model IS NULL OR embedding_model = $2)
     ORDER BY created_at DESC`,
    channelId,
    embeddingSpec
  );

  if (rows.length < minClusterSize) {
    return EMPTY_RESULT;
  }

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

  const norms = vectorNorms(embeddings);
  const clusters = clusterByEmbedding(embeddings, norms, similarityThreshold);
  const qualifying = clusters.filter((c) => c.length >= minClusterSize);

  if (qualifying.length === 0) {
    return { ...EMPTY_RESULT, clustersFound: clusters.length };
  }

  // Resolve the consolidator agent. Bind AND price against `commitToMemory` (the
  // same role `consolidateLessons` uses) so the recorded cost matches the model
  // actually used — a mismatched pricing role can resolve to zero cost.
  const consolidatorSkills = await loadAgentSkills('commitToMemory');
  const skillSuffix = consolidatorSkills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');
  const consolidatorPrompt = skillSuffix
    ? `${CHANNEL_MEMORY_CONSOLIDATOR_PROMPT}\n\n${skillSuffix}`
    : CHANNEL_MEMORY_CONSOLIDATOR_PROMPT;

  const agent = new Agent({
    id: 'channel-memory-consolidator',
    instructions: consolidatorPrompt,
    model: await getModel('commitToMemory'),
    name: 'channel-memory-consolidator',
  });

  const tracer = new AgentTracer();
  let totalCostUsd = 0;

  try {
    const clusterOutcomes = await Promise.all(
      qualifying.map(async (cluster) => {
        const clusterItems = cluster.map((idx) => rows[idx]);
        const sourceIds = clusterItems.map((m) => m.id);

        const prompt = clusterItems
          .map((m, i) => `Memory ${i + 1}:\nRationale: ${m.rationale}\nSummary: ${m.lessonSummary}`)
          .join('\n\n');

        const start = Date.now();
        const result = await agent.generate([{ content: prompt, role: 'user' }], {
          structuredOutput: { schema: ConsolidatorOutputSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = await recordLlmUsage(
            'consolidateChannelMemory',
            'commitToMemory',
            result.usage,
            'llm.consolidate_channel_memory'
          );
        }
        totalCostUsd += attribution.costUsd;

        if (!result.object) {
          return { consolidated: 0, created: 0 };
        }

        const { memories } = ConsolidatorOutputSchema.parse(result.object);

        tracer.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt: consolidatorPrompt, userMessage: prompt },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: { memoriesOut: memories.length, sourceIds },
          outputTokens: attribution.outputTokens,
          role: 'commitToMemory',
        });

        // Use the first row's team/org for the new consolidated row.
        const teamId = clusterItems[0]?.teamId ?? null;
        const orgId = clusterItems[0]?.orgId ?? null;

        // Generate embeddings before the transaction to avoid holding a DB
        // connection open during an HTTP round-trip.
        const newEmbeddings = await Promise.all(
          memories.map((m) => generateEmbeddingWithSpec(m.lessonSummary))
        );

        await prisma.$transaction(async (tx) => {
          for (let i = 0; i < memories.length; i++) {
            const memory = memories[i];
            await tx.$executeRawUnsafe(
              `INSERT INTO memory_items
               (id, channel_id, team_id, org_id, agent_key, rationale, lesson_summary,
                embedding, embedding_model, scope, metadata, created_at)
             VALUES
               (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'channelAssistant', $4, $5,
                $6::vector, $7, 'channel-memory', $8::jsonb, now())`,
              channelId,
              teamId,
              orgId,
              memory.rationale,
              memory.lessonSummary,
              JSON.stringify(newEmbeddings[i]?.embedding),
              newEmbeddings[i]?.spec ?? null,
              JSON.stringify({ clusterSize: cluster.length, consolidatedFrom: sourceIds })
            );
          }

          await tx.$executeRawUnsafe(
            `UPDATE memory_items SET consolidated_at = now() WHERE id = ANY($1::uuid[])`,
            sourceIds
          );
        });

        return { consolidated: cluster.length, created: memories.length };
      })
    );

    const finalResult: ConsolidateChannelMemoryResult = {
      clustersConsolidated: qualifying.length,
      clustersFound: clusters.length,
      memoriesConsolidated: clusterOutcomes.reduce((s, o) => s + o.consolidated, 0),
      memoriesCreated: clusterOutcomes.reduce((s, o) => s + o.created, 0),
    };

    tracer.addActivityEvent({ name: 'channel_memory.consolidated', outputJson: finalResult });

    return finalResult;
  } finally {
    await persistActivityTrace(tracer, 'commitToMemory');
    // Accrue consolidation cost to the channel's monthly budget WITHOUT counting
    // it as a user-facing run (countRun: false).
    if (totalCostUsd > 0) {
      await accrueChannelUsage(channelId, totalCostUsd, { countRun: false });
    }
  }
}
