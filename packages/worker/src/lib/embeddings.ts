import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';
import { resolveEmbeddingConfig } from './config/resolver.js';
import { parseProviderModelSpec } from './providerUtils.js';

/**
 * pgvector column for AgentLesson is `vector(1536)` (see prisma schema). All
 * embeddings written to the DB MUST be exactly 1536 dimensions, otherwise the
 * insert will fail at the SQL layer. Switching to a model with different output
 * dimensions requires a schema migration first.
 */
const REQUIRED_DIMENSIONS = 1536;

type EmbeddingModel = ReturnType<ReturnType<typeof createOpenAI>['embedding']>;

interface CachedEmbeddingModel {
  cacheKey: string;
  provider: string;
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
  const { provider, model } = await buildEmbeddingModel();
  // OpenAI's text-embedding-3-large supports a `dimensions` option to truncate
  // from its native 3072 down to the 1536 required by the pgvector column.
  // Other providers don't accept this key, so it's only sent for OpenAI.
  const { embedding } = await embed({
    model,
    value: text,
    ...(provider === 'openai'
      ? { providerOptions: { openai: { dimensions: REQUIRED_DIMENSIONS } } }
      : {}),
  });
  if (embedding.length !== REQUIRED_DIMENSIONS) {
    throw new Error(
      `Embedding model returned ${embedding.length} dimensions but the agent_lessons.embedding column is vector(${REQUIRED_DIMENSIONS}). ` +
        `Either pick a model that produces ${REQUIRED_DIMENSIONS}-dim vectors, or run a schema migration to update the column width.`
    );
  }
  return embedding;
}
