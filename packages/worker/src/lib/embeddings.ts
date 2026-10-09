import { createHash } from 'node:crypto';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { prisma } from '@auto-swe/shared/db';
import { modelCallFetch } from '@auto-swe/shared/lib/modelDiscovery';
import { embeddingProviderProblem, parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { ApplicationFailure } from '@temporalio/activity';
import { APICallError, embed } from 'ai';
import {
  currentActivityType,
  currentAttempt,
  currentTemporalRunId,
  currentWorkflowId,
} from './activityContext.js';
import { currentNodeTag, nodeTagColumns } from './activityNodeTag.js';
import { resolveEmbeddingConfig } from './config/resolver.js';
import { calculateCostUsd } from './costTracking.js';
import { recordLlmCallMetrics } from './metrics.js';
import { currentSpendOwner } from './spendOwner.js';
import { EMBEDDING_AGENT_KEY } from './traceTotals.js';

/**
 * pgvector column for MemoryItem is `vector(1536)` (see prisma schema). All
 * embeddings written to the DB MUST be exactly 1536 dimensions, otherwise the
 * insert will fail at the SQL layer. Switching to a model with different output
 * dimensions requires a schema migration first.
 */
const REQUIRED_DIMENSIONS = 1536;

type EmbeddingModel = Parameters<typeof embed>[0]['model'];

interface CachedEmbeddingModel {
  cacheKey: string;
  provider: string;
  /** Full `<provider>/<model>` spec — recorded on memory_items rows so
   *  vectors from different embedding spaces are never compared. */
  spec: string;
  model: EmbeddingModel;
  /** An OpenAI-compatible endpoint that refused the `dimensions` parameter;
   *  later calls leave it out. */
  dimensionsRejected?: boolean;
}

let cachedModel: CachedEmbeddingModel | null = null;

/** Embedding calls go through the same SSRF guard as model calls (see `models.ts`). */
const embeddingFetch = modelCallFetch();

async function buildEmbeddingModel(): Promise<CachedEmbeddingModel> {
  const { spec, apiKey, apiBase } = await resolveEmbeddingConfig();
  const { provider, modelId } = parseProviderModelSpec(spec);

  const keyDigest = createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
  const cacheKey = `${spec}|${keyDigest}|${apiBase ?? ''}`;
  if (cachedModel?.cacheKey === cacheKey) {
    return cachedModel;
  }

  let model: EmbeddingModel;
  switch (provider) {
    case 'openai':
      model = createOpenAI({ apiKey, baseURL: apiBase, fetch: embeddingFetch }).embedding(modelId);
      break;
    case 'google':
      model = createGoogleGenerativeAI({
        apiKey,
        baseURL: apiBase,
        fetch: embeddingFetch,
      }).embedding(modelId);
      break;
    default: {
      const problem = embeddingProviderProblem(provider);
      if (problem) {
        throw ApplicationFailure.nonRetryable(
          `${problem} Set it at /studio/models (Embeddings tab).`,
          'MODEL_CONFIG_INVALID'
        );
      }
      if (!apiBase) {
        throw ApplicationFailure.nonRetryable(
          `Embedding provider '${provider}' is not built-in and requires an apiBase on its credential. Set it via /studio/models (Embeddings tab).`,
          'MODEL_CONFIG_INVALID'
        );
      }
      model = createOpenAICompatible({
        apiKey,
        baseURL: apiBase,
        fetch: embeddingFetch,
        name: provider,
      }).embeddingModel(modelId);
    }
  }
  cachedModel = { cacheKey, model, provider, spec };
  return cachedModel;
}

/**
 * The provider option that asks for {@link REQUIRED_DIMENSIONS}-wide vectors.
 * OpenAI's text-embedding-3 family and Google's Gemini embeddings truncate from
 * their native width; OpenAI-compatible endpoints (OpenRouter, vLLM, Ollama)
 * take the same `dimensions` field when the model supports it.
 */
function dimensionOptions(
  cached: CachedEmbeddingModel
): Parameters<typeof embed>[0]['providerOptions'] {
  switch (cached.provider) {
    case 'openai':
      return { openai: { dimensions: REQUIRED_DIMENSIONS } };
    case 'google':
      return { google: { outputDimensionality: REQUIRED_DIMENSIONS } };
    default:
      return cached.dimensionsRejected
        ? undefined
        : { openaiCompatible: { dimensions: REQUIRED_DIMENSIONS } };
  }
}

/**
 * Embed once, and for an OpenAI-compatible endpoint that answers 400 to the
 * `dimensions` field (a model without truncation support), once more without
 * it. A model whose native width is already 1536 then works; any other width
 * still fails the dimension check below, with the reason.
 */
async function embedWithDimensions(cached: CachedEmbeddingModel, text: string) {
  const providerOptions = dimensionOptions(cached);
  try {
    return await embed({
      model: cached.model,
      value: text,
      ...(providerOptions ? { providerOptions } : {}),
    });
  } catch (err) {
    const compatible = cached.provider !== 'openai' && cached.provider !== 'google';
    if (compatible && providerOptions && APICallError.isInstance(err) && err.statusCode === 400) {
      cached.dimensionsRejected = true;
      return embed({ model: cached.model, value: text });
    }
    throw err;
  }
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
  const cached = await buildEmbeddingModel();
  const { spec } = cached;
  const start = Date.now();
  const { embedding, usage } = await embedWithDimensions(cached, text);
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
    tokens === null ? null : Math.round((await calculateCostUsd(spec, tokens, 0)) * 1e6) / 1e6;
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
    const [run, owner] = await Promise.all([
      prisma.workflowRun.findUnique({ select: { id: true }, where: { workflowId } }),
      currentSpendOwner(),
    ]);
    await prisma.agentTrace.create({
      data: {
        ...nodeTagColumns(currentNodeTag()),
        agentKey: EMBEDDING_AGENT_KEY,
        attempt,
        costUsd,
        durationMs,
        inputJson: { chars },
        inputTokens: tokens,
        model: spec,
        nodeId,
        orgId: owner.orgId ?? null,
        outputTokens: tokens === null ? null : 0,
        runId: run?.id ?? null,
        // An embedding is its own one-record batch.
        seq: 0,
        teamId: owner.teamId ?? null,
        temporalRunId: currentTemporalRunId(),
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
