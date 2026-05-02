import { embed } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { parseProviderModelSpec, createOpenAICompatibleClient } from './providerUtils.js';

/**
 * pgvector column for AgentLesson is `vector(1536)` (see prisma schema). All
 * embeddings written to the DB MUST be exactly 1536 dimensions, otherwise the
 * insert will fail at the SQL layer. Switching to a model with different output
 * dimensions requires a schema migration first.
 */
const REQUIRED_DIMENSIONS = 1536;

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-large';

type EmbeddingModel = ReturnType<ReturnType<typeof createOpenAI>['embedding']>;

let cachedModel: { spec: string; model: EmbeddingModel } | null = null;

function buildEmbeddingModel(spec: string): EmbeddingModel {
  const { provider, modelId } = parseProviderModelSpec(spec);

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for openai/* embedding models');
    }
    // text-embedding-3-large supports a `dimensions` option to truncate from 3072 → 1536.
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).embedding(modelId, {
      dimensions: REQUIRED_DIMENSIONS,
    });
  }

  return createOpenAICompatibleClient(provider).textEmbeddingModel(modelId);
}

function getEmbeddingModel(): EmbeddingModel {
  const spec = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  if (!cachedModel || cachedModel.spec !== spec) {
    cachedModel = { spec, model: buildEmbeddingModel(spec) };
  }
  return cachedModel.model;
}

/**
 * For tests — clears the cached embedding client so env changes take effect on
 * the next call.
 */
export function _resetEmbeddingClientForTests(): void {
  cachedModel = null;
}

/**
 * Generate a 1536-dimensional vector embedding for the given text. Provider is
 * selected via the `EMBEDDING_MODEL` env var (default `openai/text-embedding-3-large`).
 * Throws if the configured model returns a vector of an unexpected dimensionality,
 * since pgvector storage is fixed-width.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = getEmbeddingModel();
  const { embedding } = await embed({ model, value: text });
  if (embedding.length !== REQUIRED_DIMENSIONS) {
    throw new Error(
      `Embedding model returned ${embedding.length} dimensions but the agent_lessons.embedding column is vector(${REQUIRED_DIMENSIONS}). ` +
      `Either pick a model that produces ${REQUIRED_DIMENSIONS}-dim vectors, or run a schema migration to update the column width.`,
    );
  }
  return embedding;
}
