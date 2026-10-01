import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { prisma } from '@auto-swe/shared/db';
import { embed } from 'ai';
import { currentActivityType, currentAttempt, currentWorkflowId } from './activityContext.js';
import { resolveEmbeddingConfig } from './config/resolver.js';
import { calculateCostUsd } from './costTracking.js';
import { recordLlmCallMetrics } from './metrics.js';
import { parseProviderModelSpec } from './providerUtils.js';
import { EMBEDDING_AGENT_KEY } from './traceTotals.js';

/**
 * pgvector column for MemoryItem is `vector(1536)` (see prisma schema). All
 * embeddings written to the DB MUST be exactly 1536 dimensions, otherwise the
 * insert will fail at the SQL layer. Switching to a model with different output
 * dimensions requires a schema migration first.
 */
const REQUIRED_DIMENSIONS = 1536;

type EmbeddingModel = ReturnType<ReturnType<typeof createOpenAI>['embedding']>;

interface CachedEmbeddingModel {
  cacheKey: string;
  provider: string;
  /** Full `<provider>/<model>` spec — recorded on memory_items rows so
   *  vectors from different embedding spaces are never compared. */
  spec: string;
  model: EmbeddingModel;
}

let cachedModel: CachedEmbeddingModel | null = null;

async function buildEmbeddingModel(): Promise<CachedEmbeddingModel> {
  const { spec, apiKey, apiBase } = await resolveEmbeddingConfig();
  const { provider, modelId } = parseProviderModelSpec(spec);

  const cacheKey = `${spec}|${apiKey.slice(-6)}|${apiBase ?? ''}`;
  if (cachedModel?.cacheKey === cacheKey) {
    return cachedModel;
  }

  if (provider === 'openai') {
    cachedModel = {
      cacheKey,
      model: createOpenAI({ apiKey, baseURL: apiBase }).embedding(modelId),
      provider,
      spec,
    };
    return cachedModel;
  }
  if (!apiBase) {
    throw new Error(
      `Embedding provider '${provider}' is not built-in and requires an apiBase on its credential. Set it via /admin/model-config (Embeddings tab).`
    );
  }
  cachedModel = {
    cacheKey,
    model: createOpenAICompatible({ apiKey, baseURL: apiBase, name: provider }).textEmbeddingModel(
      modelId
    ),
    provider,
    spec,
  };
  return cachedModel;
}

/**
 * For tests — clears the cached embedding client so DB changes take effect
 * on the next call.
 */
export function _resetEmbeddingClientForTests(): void {
  cachedModel = null;
}

/**
 * Generate a 1536-dimensional vector embedding for the given text. Spec +
 * credentials come from the singleton `EmbeddingConfig` row. Throws if the
 * configured model returns a vector of the wrong dimensionality (pgvector
 * storage is fixed-width).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await generateEmbeddingWithSpec(text);
  return embedding;
}

/**
 * Like `generateEmbedding`, but also returns the `<provider>/<model>` spec the
 * vector was produced with. Writers persist the spec on memory_items so
 * retrieval/consolidation can avoid comparing vectors across embedding spaces
 * after a model switch (EVOL-4): old lessons silently degrade retrieval
 * otherwise.
 */
export async function generateEmbeddingWithSpec(
  text: string
): Promise<{ embedding: number[]; spec: string }> {
  const { provider, model, spec } = await buildEmbeddingModel();
  // OpenAI's text-embedding-3-large supports a `dimensions` option to truncate
  // from its native 3072 down to the 1536 required by the pgvector column.
  // Other providers don't accept this key, so it's only sent for OpenAI.
  const start = Date.now();
  const { embedding, usage } = await embed({
    model,
    value: text,
    ...(provider === 'openai'
      ? { providerOptions: { openai: { dimensions: REQUIRED_DIMENSIONS } } }
      : {}),
  });
  // The SDK reports `tokens: NaN` when a provider omits usage.
  const tokens = Number.isFinite(usage?.tokens) ? usage.tokens : null;
  await recordEmbeddingUsage(spec, tokens, text.length, Date.now() - start);
  if (embedding.length !== REQUIRED_DIMENSIONS) {
    throw new Error(
      `Embedding model returned ${embedding.length} dimensions but the memory_items.embedding column is vector(${REQUIRED_DIMENSIONS}). ` +
        `Either pick a model that produces ${REQUIRED_DIMENSIONS}-dim vectors, or run a schema migration to update the column width.`
    );
  }
  return { embedding, spec };
}

/**
 * Record one embedding call as an `llm_response` trace row (agent key
 * `embedding`) so its tokens and cost show up next to the run's LLM calls,
 * and add its cost to the workflow's ledger so the run total matches.
 *
 * Tokens are deliberately NOT added to the ledger's token counters: those are
 * what the per-tier budgets are measured in, and the tiers were sized for chat
 * tokens. Outside an activity (tests, scripts) there is nothing to attribute
 * to, so nothing is written. Best-effort: never fails the embedding.
 */
async function recordEmbeddingUsage(
  spec: string,
  tokens: number | null,
  chars: number,
  durationMs: number
): Promise<void> {
  const costUsd =
    tokens === null ? null : Math.round(calculateCostUsd(spec, tokens, 0) * 1e6) / 1e6;
  // Counted whether or not there is an activity to attribute it to, or usage
  // to price: the call was made either way.
  recordLlmCallMetrics({
    agent: EMBEDDING_AGENT_KEY,
    costUsd: costUsd ?? 0,
    inputTokens: tokens ?? 0,
    model: spec,
    outputTokens: 0,
  });
  let workflowId: string;
  let nodeId: string;
  let attempt: number;
  try {
    workflowId = currentWorkflowId();
    nodeId = currentActivityType();
    attempt = currentAttempt();
  } catch {
    return;
  }
  try {
    const run = await prisma.workflowRun.findUnique({
      select: { id: true },
      where: { workflowId },
    });
    await prisma.agentTrace.create({
      data: {
        agentKey: EMBEDDING_AGENT_KEY,
        attempt,
        costUsd,
        durationMs,
        inputJson: { chars },
        inputTokens: tokens,
        model: spec,
        nodeId,
        outputTokens: tokens === null ? null : 0,
        runId: run?.id ?? null,
        // An embedding is its own one-record batch.
        seq: 0,
        toolName: 'embedding',
        type: 'llm_response',
        workflowId,
      },
    });
    if (costUsd) {
      await prisma.activeWorkflow.updateMany({
        data: { costUsdAccrued: { increment: costUsd } },
        where: { temporalWorkflowId: workflowId },
      });
    }
  } catch {
    // Usage bookkeeping is best-effort — never fail the caller's embedding.
  }
}

/**
 * Current embedding spec without generating a vector — used by retrieval
 * queries to scope similarity search to vectors from the same space.
 */
export async function currentEmbeddingSpec(): Promise<string> {
  const { spec } = await buildEmbeddingModel();
  return spec;
}
