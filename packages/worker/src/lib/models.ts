import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { currentRequestContext } from './config/contextLookup.js';
import { resolveModelConfig } from './config/resolver.js';
import type { AgentRole as ConfigAgentRole } from './config/types.js';
import { parseProviderModelSpec } from './providerUtils.js';

// All Vercel AI SDK provider factories return the same LanguageModelV1 shape; we
// derive the type from the existing anthropic provider so we don't take a hard
// dependency on @ai-sdk/provider (the type-only package is a transitive dep).
type LanguageModel = ReturnType<typeof anthropic>;

export type AgentRole = ConfigAgentRole;

/**
 * Returns the configured model spec for a role at the current scope. Picks up
 * `{ teamId, workflowTemplateId }` from the Temporal activity context.
 * Throws `ConfigMissingError` if the GLOBAL ModelRoleConfig row is missing
 * (the worker's startup check should have caught this; runtime delete is
 * the only way to hit it now).
 */
export async function getModelSpec(role: AgentRole): Promise<string> {
  const ctx = await currentRequestContext();
  const resolved = await resolveModelConfig(role, ctx);
  return resolved.spec;
}

/**
 * Returns the language model bound to a given agent role. Same scope-
 * resolution semantics as `getModelSpec`. Throws if config is missing.
 * Process-local cache keeps us from rebuilding a fresh provider client on
 * every call to the same role+context combo.
 */
export async function getModel(role: AgentRole): Promise<LanguageModel> {
  const ctx = await currentRequestContext();
  const resolved = await resolveModelConfig(role, ctx);
  return buildModel(resolved.spec, resolved.apiKey, resolved.apiBase);
}

/**
 * Builds a Vercel AI SDK LanguageModel from a `<provider>/<model>` spec and an
 * explicit API key. No env-default fallbacks — the caller MUST supply the
 * apiKey from the resolver. Exported for tests and ad-hoc CLI scripts that
 * already have credentials in hand.
 */
export function resolveModel(spec: string, apiKey: string, apiBase?: string): LanguageModel {
  return buildModel(spec, apiKey, apiBase);
}

// ── Cache of constructed LanguageModel instances ──

const modelCache = new Map<string, LanguageModel>();

function cacheKeyForBuild(spec: string, apiKey: string, apiBase: string | undefined): string {
  // Hash-ish key — include the last 6 chars of the apiKey so a credential
  // rotation in the DB busts the cache without holding the full secret in the
  // map key. apiBase is included verbatim since it's non-secret.
  const keyTail = apiKey.slice(-6);
  const base = apiBase ?? '';
  return `${spec}|${keyTail}|${base}`;
}

function buildModel(spec: string, apiKey: string, apiBase?: string): LanguageModel {
  const key = cacheKeyForBuild(spec, apiKey, apiBase);
  const cached = modelCache.get(key);
  if (cached) return cached;

  const built = buildModelUncached(spec, apiKey, apiBase);
  modelCache.set(key, built);
  return built;
}

function buildModelUncached(spec: string, apiKey: string, apiBase?: string): LanguageModel {
  const { provider, modelId } = parseProviderModelSpec(spec);

  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: apiBase })(modelId);
    case 'openai':
      return createOpenAI({ apiKey, baseURL: apiBase })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: apiBase })(modelId);
    default:
      // OpenAI-compatible providers require an apiBase. Throw a clear error
      // so the operator notices the bad config rather than silently failing
      // with an unhelpful SDK error.
      if (!apiBase) {
        throw new Error(
          `Provider '${provider}' is not built-in and requires an apiBase on its credential. Set it via /admin/model-config.`
        );
      }
      return createOpenAICompatible({ apiKey, baseURL: apiBase, name: provider })(modelId);
  }
}

/// Drops the model-build cache. Used in tests and after credential rotations.
export function _resetModelCacheForTests(): void {
  modelCache.clear();
}

// Suppress unused-warnings on the bare SDK exports — kept for back-compat
// with callers (tests, CLI scripts) that already imported them by name.
void anthropic;
void openai;
void google;

// Re-export createX functions so callers needing custom client options (e.g. baseURL
// overrides for Bedrock/Azure) can construct providers directly without re-importing
// the underlying SDK packages.
export { createAnthropic, createGoogleGenerativeAI, createOpenAI, createOpenAICompatible };
