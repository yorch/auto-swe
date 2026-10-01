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
