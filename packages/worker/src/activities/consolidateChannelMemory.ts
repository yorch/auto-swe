import { prisma } from '@auto-swe/shared/db';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { currentEmbeddingSpec, generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { getModel } from '../lib/models.js';
import { accrueChannelUsage } from './channelAssistant.js';

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

// ── Helpers (shared with consolidateLessons) ─────────────────────────────────

interface RawMemoryItem {
  id: string;
  lessonSummary: string;
  rationale: string;
  embeddingJson: string | null;
  teamId: string | null;
  orgId: string | null;
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

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

// ── Prompt ───────────────────────────────────────────────────────────────────

const CHANNEL_MEMORY_CONSOLIDATOR_PROMPT = [
  'You are a memory-consolidation assistant for a Slack channel.',
  'You will receive a cluster of related channel-memory items (facts, decisions,',
  'Q&A, and context this channel has discussed) that are semantically similar to',
  'each other. Consolidate them into ONE or TWO durable, reusable facts that',
  'capture the essence of the cluster without redundancy.',
  '',
  'For each output memory:',
  '- `lessonSummary`: A clear, concrete fact worth remembering (1–2 sentences).',
  '- `rationale`: Why this matters / when it is useful (1 sentence).',
  '',
  'Return valid JSON: { "memories": [ { "lessonSummary": "…", "rationale": "…" } ] }',
  'Return at most 2 memories per cluster — prefer one if the items all say the same thing.',
].join('\n');

// ── Activity ─────────────────────────────────────────────────────────────────

/**
 * Channel assistant (Gap F): consolidate semantically similar channel-memory
 * items to prevent the "memory bloat / stale / noisy" failure mode.
 *
 * Mirrors `consolidateLessons` (repo-scoped) but targets the channel memory
 * scope: fetches all un-consolidated `memory_items` for a channel, clusters
 * them by cosine similarity, synthesises each qualifying cluster into 1–2
 * durable facts via an LLM, and soft-deletes the originals
 * (`consolidated_at = now()`). The synthesised rows carry provenance metadata.
 *
 * Called from `ChannelAmbientWorkflow` on each ambient fire so the channel's
 * memory stays clean over time. Best-effort by the caller (a failure here
 * must not stop the ambient digest).
 *
 * Cost accrual: the LLM synthesis calls accrue to `ChannelMonthlyUsage` (the
 * per-channel budget), not to `OrgMonthlyUsage` — consolidation is a channel
 * operation, not a normal work request.
 */
export async function consolidateChannelMemory(
  input: ConsolidateChannelMemoryInput
): Promise<ConsolidateChannelMemoryResult> {
  const { channelId, minClusterSize = 3, similarityThreshold = 0.85 } = input;

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
    return { clustersConsolidated: 0, clustersFound: 0, memoriesConsolidated: 0, memoriesCreated: 0 };
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
      memoriesConsolidated: 0,
      memoriesCreated: 0,
    };
  }

  // Resolve the consolidator agent (inherits model from commitToMemory).
  const consolidatorSkills = await loadAgentSkills('lessonConsolidator');
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
          .map(
            (m, i) =>
              `Memory ${i + 1}:\nRationale: ${m.rationale}\nSummary: ${m.lessonSummary}`
          )
          .join('\n\n');

        const start = Date.now();
        const result = await agent.generate([{ content: prompt, role: 'user' }], {
          structuredOutput: { schema: ConsolidatorOutputSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = await recordLlmUsage(
            'consolidateChannelMemory',
            'lessonConsolidator',
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
          role: 'lessonConsolidator',
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
               (id, channel_id, team_id, org_id, rationale, lesson_summary,
                embedding, embedding_model, scope, metadata, created_at)
             VALUES
               (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5,
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

    const totalConsolidated = clusterOutcomes.reduce((s, o) => s + o.consolidated, 0);
    const totalCreated = clusterOutcomes.reduce((s, o) => s + o.created, 0);

    const finalResult: ConsolidateChannelMemoryResult = {
      clustersConsolidated: qualifying.length,
      clustersFound: clusters.length,
      memoriesConsolidated: totalConsolidated,
      memoriesCreated: totalCreated,
    };

    tracer.addActivityEvent({ name: 'channel_memory.consolidated', outputJson: finalResult });

    return finalResult;
  } finally {
    await persistActivityTrace(tracer, 'commitToMemory');
    // Accrue consolidation cost to the channel's monthly budget.
    if (totalCostUsd > 0) {
      await accrueChannelUsage(channelId, totalCostUsd);
    }
  }
}
