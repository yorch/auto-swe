import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { currentRequestContext } from './config/contextLookup.js';
import { resolveModelConfig } from './config/resolver.js';
import type { AgentRole as ConfigAgentRole } from './config/types.js';
import { createOpenAICompatibleClient, parseProviderModelSpec } from './providerUtils.js';

// All Vercel AI SDK provider factories return the same LanguageModelV1 shape; we
// derive the type from the existing anthropic provider so we don't take a hard
// dependency on @ai-sdk/provider (the type-only package is a transitive dep).
type LanguageModel = ReturnType<typeof anthropic>;

export type AgentRole = ConfigAgentRole;

/**
 * Returns the configured model spec for a role at the current scope. Picks up
 * `{ teamId, workflowTemplateId }` from the Temporal activity context; falls
 * back to env vars when called outside an activity (tests / worker boot).
 */
export async function getModelSpec(role: AgentRole): Promise<string> {
  const ctx = await currentRequestContext();
  const resolved = await resolveModelConfig(role, ctx);
  return resolved.spec;
}

/**
 * Returns the language model bound to a given agent role. Same scope-resolution
 * semantics as `getModelSpec`. Process-local cache keeps us from rebuilding a
 * fresh provider client on every call to the same role+context combo.
 */
export async function getModel(role: AgentRole): Promise<LanguageModel> {
  const ctx = await currentRequestContext();
  const resolved = await resolveModelConfig(role, ctx);
  return buildModel(resolved.spec, resolved.apiKey, resolved.apiBase);
}

/**
 * Builds a Vercel AI SDK LanguageModel from a `<provider>/<model>` spec.
 * When `apiKey` is provided (DB-backed credential), constructs a fresh client
 * with that key + optional `apiBase`. Without it, falls back to the env-driven
 * default client (anthropic(), openai(), google(), or the OpenAI-compatible
 * fallback that reads `<PROVIDER>_API_BASE` / `<PROVIDER>_API_KEY`).
 *
 * Exported for tests and for cases (e.g. ad-hoc CLI scripts) where the caller
 * already has a spec string in hand.
 */
export function resolveModel(spec: string, apiKey?: string, apiBase?: string): LanguageModel {
  return buildModel(spec, apiKey, apiBase);
}

// ── Cache of constructed LanguageModel instances ──

const modelCache = new Map<string, LanguageModel>();

function cacheKeyForBuild(
  spec: string,
  apiKey: string | undefined,
  apiBase: string | undefined
): string {
  // Hash-ish key — include the last 6 chars of the apiKey so a credential
  // rotation in the DB busts the cache without holding the full secret in the
  // map key. apiBase is included verbatim since it's non-secret.
  const keyTail = apiKey ? `:${apiKey.slice(-6)}` : '';
  const base = apiBase ?? '';
  return `${spec}|${keyTail}|${base}`;
}

function buildModel(spec: string, apiKey?: string, apiBase?: string): LanguageModel {
  const key = cacheKeyForBuild(spec, apiKey, apiBase);
  const cached = modelCache.get(key);
  if (cached) return cached;

  const built = buildModelUncached(spec, apiKey, apiBase);
  modelCache.set(key, built);
  return built;
}

function buildModelUncached(spec: string, apiKey?: string, apiBase?: string): LanguageModel {
  const { provider, modelId } = parseProviderModelSpec(spec);

  switch (provider) {
    case 'anthropic':
      if (apiKey) return createAnthropic({ apiKey, baseURL: apiBase })(modelId);
      return anthropic(modelId);
    case 'openai':
      if (apiKey) return createOpenAI({ apiKey, baseURL: apiBase })(modelId);
      return openai(modelId);
    case 'google':
      if (apiKey) return createGoogleGenerativeAI({ apiKey, baseURL: apiBase })(modelId);
      return google(modelId);
    default:
      // OpenAI-compatible fallback. If we have a DB-backed apiBase, use it
      // directly; otherwise read the env-var pair the way we always have.
      if (apiBase) {
        return createOpenAICompatible({ apiKey, baseURL: apiBase, name: provider })(modelId);
      }
      // DB cred without an apiBase is unusable here — we have no endpoint.
      // Fail loudly rather than silently dropping the key.
      if (apiKey) {
        throw new Error(
          `Provider credential for '${provider}' has an apiKey but no apiBase, and '${provider}' is not a built-in provider. Set an apiBase on the credential (dashboard or ${provider.toUpperCase().replace(/-/g, '_')}_API_BASE env var).`
        );
      }
      return createOpenAICompatibleClient(provider)(modelId);
  }
}

/// Drops the model-build cache. Used in tests and after credential rotations.
export function _resetModelCacheForTests(): void {
  modelCache.clear();
}

// Re-export createX functions so callers needing custom client options (e.g. baseURL
// overrides for Bedrock/Azure) can construct providers directly without re-importing
// the underlying SDK packages.
export { createAnthropic, createGoogleGenerativeAI, createOpenAI, createOpenAICompatible };
