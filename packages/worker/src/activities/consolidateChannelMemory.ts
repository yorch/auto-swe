import { resolveSetting } from '@auto-swe/shared/config';
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
import { isChannelOverBudgetNow, reserveChannelTurn } from './channelAssistant.js';

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
 * without spending (same cheap `isChannelOverBudgetNow` bail the digest uses). Its
 * cost settles against `ChannelMonthlyUsage` (the per-channel budget) via the hold
 * with `countRun: false` — consolidation is maintenance, not a user-facing run, so
 * it must not inflate `runsCompleted`.
 */
export async function consolidateChannelMemory(
  input: ConsolidateChannelMemoryInput
): Promise<ConsolidateChannelMemoryResult> {
  const { channelId } = input;

  // Per-channel consolidation config (Gap F): load the enable flag + optional
  // tuning overrides alongside the budget cap. A channel can opt OUT of
  // consolidation, or tune its cluster size / similarity threshold; otherwise the
  // built-in defaults apply (or whatever the caller passed via `input`).
  const channel = await prisma.slackChannel.findUnique({
    select: {
      consolidationEnabled: true,
      consolidationMinClusterSize: true,
      consolidationSimilarityThreshold: true,
      monthlyBudgetUsdCents: true,
      orgId: true,
      teamId: true,
    },
    where: { id: channelId },
  });

  // Opt-out: a channel with consolidation disabled is a no-op (the default is on,
  // so existing channels are unchanged).
  if (channel && channel.consolidationEnabled === false) {
    return EMPTY_RESULT;
  }

  // Effective params: per-channel override ?? caller input ?? configured default.
  // The registry default has to be the same one passive ingest uses — the two
  // halves of the memory pipeline disagreeing about what counts as a duplicate
  // is exactly the drift a shared setting exists to prevent.
  const minClusterSize = channel?.consolidationMinClusterSize ?? input.minClusterSize ?? 3;
  const similarityThreshold =
    channel?.consolidationSimilarityThreshold ??
    input.similarityThreshold ??
    (await resolveSetting('channel.memoryDedupThreshold', {
      channelId,
      orgId: channel?.orgId ?? undefined,
      teamId: channel?.teamId ?? undefined,
    }));

  // Budget gate: skip consolidation entirely when the channel is over its monthly
  // cap, so an exhausted channel doesn't keep spending on every ambient fire.
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
  //
  // Resolve at the CHANNEL tier explicitly: this pass runs on a channel's
  // ledger, and its hold is priced through `resolveAgent(..., { channelId })`.
  // The ambient Temporal context has no channelId, so without this a
  // channel-scoped `commitToMemory` override would be priced but never used.
  const agentCtx = {
    channelId,
    orgId: channel?.orgId ?? '',
    teamId: channel?.teamId ?? '',
  };
  const consolidatorSkills = await loadAgentSkills('commitToMemory', agentCtx);
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
    model: await getModel('commitToMemory', agentCtx),
    name: 'channel-memory-consolidator',
  });

  const tracer = new AgentTracer();
  let totalCostUsd = 0;

  // Hold budget for this pass before it spends. One model call per qualifying
  // cluster, so the hold covers the whole fan-out — a single-call hold would
  // admit a 30-cluster pass on the headroom of one turn. Released — or replaced
  // by the real total — in the `finally` below.
  const hold = await reserveChannelTurn(channelId, channel?.monthlyBudgetUsdCents ?? null, {
    agentKey: 'commitToMemory',
    modelCalls: qualifying.length,
    orgId: agentCtx.orgId,
    teamId: agentCtx.teamId,
  });
  if (hold.overBudget) {
    return EMPTY_RESULT;
  }

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
    // Settle consolidation cost against the channel's monthly budget WITHOUT
    // counting it as a user-facing run (countRun: false). Unconditional: a pass
    // that spent nothing still has to give its hold back.
    await hold.settle(totalCostUsd, { countRun: false });
  }
}
