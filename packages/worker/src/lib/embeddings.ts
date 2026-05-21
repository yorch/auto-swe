import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';
import { currentRequestContext } from './config/contextLookup.js';
import { resolveProviderCredential } from './config/resolver.js';
import { createOpenAICompatibleClient, parseProviderModelSpec } from './providerUtils.js';

/**
 * pgvector column for AgentLesson is `vector(1536)` (see prisma schema). All
 * embeddings written to the DB MUST be exactly 1536 dimensions, otherwise the
 * insert will fail at the SQL layer. Switching to a model with different output
 * dimensions requires a schema migration first.
 */
const REQUIRED_DIMENSIONS = 1536;

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-large';

type EmbeddingModel = ReturnType<ReturnType<typeof createOpenAI>['embedding']>;

interface CachedEmbeddingModel {
  spec: string;
  provider: string;
  model: EmbeddingModel;
  cacheKey: string;
}

let cachedModel: CachedEmbeddingModel | null = null;

/// Embedding-model spec lookup. Embeddings have one role across the system
/// (memory-commit), so we use a single env var rather than the per-role
/// `ModelRoleConfig` table. Credentials still flow through the resolver so
/// you can override the OpenAI API key from the dashboard.
async function buildEmbeddingModel(): Promise<CachedEmbeddingModel> {
  const spec = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const { provider, modelId } = parseProviderModelSpec(spec);

  const ctx = await currentRequestContext();
  const cred = await resolveProviderCredential(provider, ctx);
  const apiKey = cred?.apiKey;
  const apiBase = cred?.apiBase;

  const cacheKey = `${spec}|${apiKey ? apiKey.slice(-6) : ''}|${apiBase ?? ''}`;
  if (cachedModel?.cacheKey === cacheKey) return cachedModel;

  if (provider === 'openai') {
    const effectiveKey = apiKey ?? process.env.OPENAI_API_KEY;
    if (!effectiveKey) {
      throw new Error('OPENAI_API_KEY is required for openai/* embedding models');
    }
    cachedModel = {
      cacheKey,
      model: createOpenAI({ apiKey: effectiveKey, baseURL: apiBase }).embedding(modelId),
      provider,
      spec,
    };
    return cachedModel;
  }

  // Non-OpenAI providers route through the OpenAI-compatible client. Prefer
  // DB-backed credentials; fall back to `<PROVIDER>_API_BASE` / `<PROVIDER>_API_KEY`
  // env vars so deployments that haven't migrated to DB-backed config still work.
  if (apiBase) {
    cachedModel = {
      cacheKey,
      model: createOpenAICompatible({
        apiKey,
        baseURL: apiBase,
        name: provider,
      }).textEmbeddingModel(modelId),
      provider,
      spec,
    };
    return cachedModel;
  }
  // A DB credential without an apiBase is unusable for OpenAI-compatible
  // providers — we have no endpoint to call. Fail loudly so the operator
  // notices the bad config rather than silently dropping the key.
  if (apiKey) {
    throw new Error(
      `Provider credential for '${provider}' has an apiKey but no apiBase, and '${provider}' is not a built-in provider. Set an apiBase on the credential (dashboard or ${provider.toUpperCase().replace(/-/g, '_')}_API_BASE env var).`
    );
  }
  cachedModel = {
    cacheKey,
    model: createOpenAICompatibleClient(provider).textEmbeddingModel(modelId),
    provider,
    spec,
  };
  return cachedModel;
}

/**
 * For tests — clears the cached embedding client so env or DB changes take
 * effect on the next call.
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
