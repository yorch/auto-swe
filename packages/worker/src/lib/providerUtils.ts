import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface ProviderModelSpec {
  provider: string;
  modelId: string;
}

/**
 * Splits a `<provider>/<model-id>` string into its parts. The model id may
 * contain additional slashes (e.g. `openrouter/anthropic/claude-opus-4-6`).
 *
 * The provider name is lowercased so resolution is case-insensitive — `OpenAI/gpt-5`,
 * `openai/gpt-5`, and `OPENAI/gpt-5` all route to the built-in OpenAI provider rather
 * than falling through to the OpenAI-compatible fallback with a misleading error.
 * The model id is preserved as written since some endpoints (e.g. self-hosted models)
 * are case-sensitive about model identifiers.
 */
export function parseProviderModelSpec(spec: string): ProviderModelSpec {
  const slash = spec.indexOf('/');
  if (slash === -1) {
    throw new Error(
      `Invalid model spec '${spec}'. Expected '<provider>/<model>' (e.g. 'anthropic/claude-opus-4-6').`
    );
  }
  const provider = spec.slice(0, slash).trim().toLowerCase();
  const modelId = spec.slice(slash + 1).trim();
  if (!provider || !modelId) {
    throw new Error(`Invalid model spec '${spec}'. Both provider and model must be non-empty.`);
  }
  return { provider, modelId };
}

/**
 * Normalises a provider name to its env-var prefix: uppercased, hyphens → underscores.
 * Example: `my-gateway` → `MY_GATEWAY`.
 */
export function providerEnvPrefix(provider: string): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

/**
 * Builds an OpenAI-compatible client for any provider name not built into the
 * Vercel AI SDK. Reads `<PROVIDER>_API_BASE` (required) and `<PROVIDER>_API_KEY`
 * (optional) from the environment.
 *
 * Used as the fallback path for both chat models (in `models.ts`) and embeddings
 * (in `embeddings.ts`) — covers OpenRouter, Ollama, vLLM, Groq, Cerebras,
 * Inflection Pi, etc.
 */
export function createOpenAICompatibleClient(
  provider: string
): ReturnType<typeof createOpenAICompatible> {
  const prefix = providerEnvPrefix(provider);
  const baseURL = process.env[`${prefix}_API_BASE`];
  if (!baseURL) {
    throw new Error(
      `Unknown provider '${provider}'. Set ${prefix}_API_BASE to use it as an OpenAI-compatible endpoint.`
    );
  }
  const apiKey = process.env[`${prefix}_API_KEY`];
  return createOpenAICompatible({ name: provider, baseURL, apiKey });
}
