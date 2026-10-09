import { createHash } from 'node:crypto';
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { ApplicationFailure } from '@temporalio/activity';
import { type LanguageModel as AiLanguageModel, wrapLanguageModel } from 'ai';
import { resolveAgent } from './config/agentResolver.js';
import { currentRequestContext } from './config/contextLookup.js';
import type {
  AnySkillRole,
  ModelBackedAgentKey as ConfigModelBackedAgentKey,
  ResolveCtx,
} from './config/types.js';
import { schemaInPromptMiddleware } from './schemaInPrompt.js';

// The provider factories no longer agree on a return type: since
// @ai-sdk/anthropic 4.0.34 the Anthropic and OpenAI providers return the
// batch-capable `BatchLanguageModelV4`, while Google and the OpenAI-compatible
// adapter still return plain `LanguageModelV4`. Deriving this alias from
// `anthropic` therefore made the two narrower providers unassignable. Select
// the v4 member of the SDK's own model union instead — that is the interface
// every factory here implements, and it stays correct as providers gain
// capabilities, without taking a direct dependency on @ai-sdk/provider.
export type LanguageModel = Extract<AiLanguageModel, { specificationVersion: 'v4' }>;

export type ModelBackedAgentKey = ConfigModelBackedAgentKey;

/**
 * Returns the configured model spec for a role at the current scope. Picks up
 * `{ teamId, workflowTemplateId }` from the Temporal activity context.
 * Throws `ConfigMissingError` if the GLOBAL ModelRoleConfig row is missing
 * (the worker's startup check should have caught this; runtime delete is
 * the only way to hit it now).
 */
export async function getModelSpec(role: AnySkillRole): Promise<string> {
  const ctx = await currentRequestContext();
  const resolved = await resolveAgent(role, ctx);
  return resolved.model.spec;
}

/**
 * Returns the language model bound to a given agent role. Same scope-
 * resolution semantics as `getModelSpec`. Throws if config is missing.
 * Process-local cache keeps us from rebuilding a fresh provider client on
 * every call to the same role+context combo.
 *
 * `ctx` overrides fields on the ambient activity context — channel-resident
 * callers pass `{ channelId }` so the CHANNEL tier fires, which the Temporal
 * context cannot supply. Same optional-override shape as `loadAgentSkills`.
 */
export async function getModel(
  role: AnySkillRole,
  ctx?: Partial<ResolveCtx>
): Promise<LanguageModel> {
  const resolveCtx = { ...(await currentRequestContext()), ...ctx };
  const { model } = await resolveAgent(role, resolveCtx);
  return buildModel(model.spec, model.apiKey, model.apiBase);
}

/**
 * Resolves a role once and returns the bound model together with the
 * `<provider>/<model>` spec it was built from. Callers that price their own
 * spend pass `spec` to `recordLlmUsage` so the call is charged at the model
 * that was bound here — re-resolving the role from the ambient activity context
 * cannot see the CHANNEL tier and would price a different model. `systemPrompt` is
 * the same resolution's prompt (null when the row sets none), so a caller that
 * needs the model, its price and its prompt reads config once, not three times.
 */
export async function getBoundModel(
  role: AnySkillRole,
  ctx?: Partial<ResolveCtx>
): Promise<{ model: LanguageModel; spec: string; systemPrompt: string | null }> {
  const resolveCtx = { ...(await currentRequestContext()), ...ctx };
  const { model } = await resolveAgent(role, resolveCtx);
  return {
    model: buildModel(model.spec, model.apiKey, model.apiBase),
    spec: model.spec,
    systemPrompt: model.systemPrompt ?? null,
  };
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

/** Upper bound on cached clients; the least recently used is dropped past it. */
const MODEL_CACHE_MAX = 256;

const modelCache = new Map<string, LanguageModel>();

function cacheKeyForBuild(spec: string, apiKey: string, apiBase: string | undefined): string {
  // A digest of the whole key, never the key itself: two credentials that share
  // a spec and apiBase (two teams' keys for one OpenAI-compatible endpoint) must
  // not share a client, and a rotation in the DB must bust the entry. apiBase is
  // non-secret and included verbatim.
  const keyDigest = createHash('sha256').update(apiKey).digest('hex').slice(0, 32);
  return `${spec}|${keyDigest}|${apiBase ?? ''}`;
}

function buildModel(spec: string, apiKey: string, apiBase?: string): LanguageModel {
  const key = cacheKeyForBuild(spec, apiKey, apiBase);
  const cached = modelCache.get(key);
  if (cached) {
    // Re-insert so Map iteration order tracks recency.
    modelCache.delete(key);
    modelCache.set(key, cached);
    return cached;
  }

  const built = buildModelUncached(spec, apiKey, apiBase);
  modelCache.set(key, built);
  if (modelCache.size > MODEL_CACHE_MAX) {
    const oldest = modelCache.keys().next().value;
    if (oldest !== undefined) {
      modelCache.delete(oldest);
    }
  }
  return built;
}

function buildModelUncached(spec: string, apiKey: string, apiBase?: string): LanguageModel {
  const { provider, modelId } = parseProviderModelSpec(spec);

  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL: apiBase })(modelId);
    case 'openai': {
      const openaiProvider = createOpenAI({ apiKey, baseURL: apiBase });
      // The default OpenAI model speaks the Responses API. A credential with an
      // apiBase points at a proxy or gateway (LiteLLM, Azure, a corporate
      // relay), and most of those serve only Chat Completions — so a custom
      // base gets the Chat Completions model, which OpenAI itself also serves.
      return apiBase ? openaiProvider.chat(modelId) : openaiProvider(modelId);
    }
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: apiBase })(modelId);
    default:
      // OpenAI-compatible providers require an apiBase. Throw a clear error
      // so the operator notices the bad config rather than silently failing
      // with an unhelpful SDK error.
      if (!apiBase) {
        // Deterministic: retrying the activity cannot add the missing apiBase.
        throw ApplicationFailure.nonRetryable(
          `Provider '${provider}' is not built-in and requires an apiBase on its credential. Set it via /studio/models.`,
          'MODEL_CONFIG_INVALID'
        );
      }
      // The adapter sends JSON mode without the schema; put the schema in the
      // prompt so structured-output callers get the shape they validate.
      return wrapLanguageModel({
        middleware: schemaInPromptMiddleware,
        model: createOpenAICompatible({ apiKey, baseURL: apiBase, name: provider })(modelId),
      });
  }
}

/**
 * Resolves the system prompt for a role using the same scope cascade as
 * `resolveAgent`. Priority order:
 *  1. `configOverride` — returned immediately if truthy (no DB access).
 *  2. `systemPrompt` from the DB-resolved `ModelRoleConfig` row.
 *  3. `fallback` — used when the DB row has no system prompt set.
 */
export async function resolveSystemPrompt(
  role: string,
  fallback: string,
  configOverride?: string
): Promise<string> {
  if (configOverride) {
    return configOverride;
  }
  const ctx = await currentRequestContext();
  const { model } = await resolveAgent(role, ctx);
  return model.systemPrompt ?? fallback;
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
