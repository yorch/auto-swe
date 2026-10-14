import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { ApplicationFailure } from '@temporalio/activity';
import { defineHarness } from '../harness/registry.js';
import { PI_CAPABILITIES, piToolsGranting } from './policy.js';
import { type PiAccess, piRuntime } from './runtime.js';

/** The providers the worker's model binding serves without an `apiBase` (`lib/models.ts`). */
const BUILT_IN_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

/**
 * Pi in the harness registry.
 *
 * Pi's model calls go through the worker's own model binding, so it drives any
 * model the Mastra loop can: a built-in provider, or an OpenAI-compatible one
 * whose credential names an `apiBase`. A model with neither is refused here,
 * before anything is built.
 */
export const piHarness = defineHarness<PiAccess>({
  bindModel(agentKey, model) {
    const { provider } = parseProviderModelSpec(model.spec);
    if (!BUILT_IN_PROVIDERS.has(provider) && !model.apiBase) {
      throw ApplicationFailure.nonRetryable(
        `The pi runtime cannot reach agent '${agentKey}''s model '${model.spec}': provider '${provider}' is not built in and its credential has no apiBase. Set one via /studio/models.`,
        'HARNESS_UNSUPPORTED_MODEL'
      );
    }
    return { apiBase: model.apiBase, apiKey: model.apiKey, spec: model.spec };
  },
  capabilities: PI_CAPABILITIES,
  createRuntime: ({ exactToolKeys, ...options }) =>
    piRuntime(exactToolKeys ? { ...options, tools: piToolsGranting(exactToolKeys) } : options),
  kind: 'pi',
  label: 'Pi',
});
