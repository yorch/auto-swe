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
  return { modelId, provider };
}

/**
 * The canonical spelling of a spec: provider trimmed and lowercased, model id as
 * written. Credential lookup already reads the provider this way, so storing and
 * pricing the canonical form keeps `OpenAI/gpt-6-luna` from running on the
 * `openai` credential while being priced (and harness-checked) as an unknown
 * provider. Throws on a malformed spec, as {@link parseProviderModelSpec} does.
 */
export function normalizeModelSpec(spec: string): string {
  const { provider, modelId } = parseProviderModelSpec(spec);
  return `${provider}/${modelId}`;
}

/**
 * Why a provider cannot back the embedding model, or null when it can. Anthropic
 * is a built-in chat provider with no embedding endpoint; every other built-in
 * and any OpenAI-compatible endpoint may serve one.
 */
export function embeddingProviderProblem(provider: string): string | null {
  return provider.trim().toLowerCase() === 'anthropic'
    ? "Provider 'anthropic' has no embedding models. Pick an OpenAI, Google or OpenAI-compatible embedding model."
    : null;
}

/**
 * Whether a spec routes to Anthropic — the only provider the claude-code
 * harness can drive. Case-insensitive, as credential routing is, so a row saved
 * as `Anthropic/…` before specs were stored canonical still qualifies.
 */
export function isAnthropicSpec(spec: string): boolean {
  return spec.trim().toLowerCase().startsWith('anthropic/');
}

/** The providers with their own client; any other name is an OpenAI-compatible endpoint. */
export const BUILTIN_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google'];

/** Whether `provider` has its own client, so its credential needs no `apiBase`. */
export function isBuiltInProvider(provider: string): boolean {
  return BUILTIN_PROVIDERS.includes(provider.trim().toLowerCase());
}
