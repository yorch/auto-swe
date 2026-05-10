import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAICompatibleClient, parseProviderModelSpec } from './providerUtils.js';

// All Vercel AI SDK provider factories return the same LanguageModelV1 shape; we
// derive the type from the existing anthropic provider so we don't take a hard
// dependency on @ai-sdk/provider (the type-only package is a transitive dep).
type LanguageModel = ReturnType<typeof anthropic>;

export type AgentRole =
  | 'implementer'
  | 'reviewer'
  | 'planner'
  | 'securityReview'
  | 'validateContext'
  | 'commitToMemory';

const DEFAULT_MODELS: Record<AgentRole, string> = {
  commitToMemory: 'anthropic/claude-opus-4-6',
  implementer: 'anthropic/claude-opus-4-6',
  planner: 'anthropic/claude-sonnet-4-20250514',
  reviewer: 'anthropic/claude-opus-4-6',
  securityReview: 'anthropic/claude-sonnet-4-20250514',
  validateContext: 'anthropic/claude-sonnet-4-20250514',
};

const ROLE_ENV_VAR: Record<AgentRole, string> = {
  commitToMemory: 'MEMORY_SUMMARIZER_MODEL',
  implementer: 'IMPLEMENTER_MODEL',
  planner: 'PLANNER_MODEL',
  reviewer: 'REVIEWER_MODEL',
  securityReview: 'SECURITY_REVIEW_MODEL',
  validateContext: 'CONTEXT_VALIDATOR_MODEL',
};

/**
 * Returns the configured model spec for a role: env override, falling back to the default.
 */
export function getModelSpec(role: AgentRole): string {
  return process.env[ROLE_ENV_VAR[role]]?.trim() || DEFAULT_MODELS[role];
}

/**
 * Resolves a `<provider>/<model>` spec to a concrete Vercel AI SDK LanguageModel.
 *
 * Built-in providers: anthropic, openai, google.
 * Any other provider name is treated as an OpenAI-compatible endpoint and requires
 * `<UPPER>_API_BASE` (and typically `<UPPER>_API_KEY`) env vars — covers OpenRouter,
 * Ollama, vLLM, Groq, Cerebras, Inflection Pi, etc.
 */
export function resolveModel(spec: string): LanguageModel {
  const { provider, modelId } = parseProviderModelSpec(spec);

  switch (provider) {
    case 'anthropic':
      return anthropic(modelId);
    case 'openai':
      return openai(modelId);
    case 'google':
      return google(modelId);
    default:
      return createOpenAICompatibleClient(provider)(modelId);
  }
}

/**
 * Returns the language model bound to a given agent role. Reads `<ROLE>_MODEL`
 * env vars at call time so configuration changes take effect on the next workflow run.
 */
export function getModel(role: AgentRole): LanguageModel {
  return resolveModel(getModelSpec(role));
}

// Re-export createX functions so callers needing custom client options (e.g. baseURL
// overrides for Bedrock/Azure) can construct providers directly without re-importing
// the underlying SDK packages.
export { createAnthropic, createGoogleGenerativeAI, createOpenAI, createOpenAICompatible };
