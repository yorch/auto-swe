import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import type { ReasoningLevel } from '@auto-swe/shared/types/api';
import type { LanguageModelMiddleware } from 'ai';

type CallParams = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

/** The AI SDK's provider-neutral reasoning call setting. */
export type ReasoningCallSetting = NonNullable<CallParams['reasoning']>;

/**
 * The providers whose AI SDK adapter maps the reasoning call setting onto the
 * provider's own option, per model: Anthropic to adaptive thinking and an
 * effort (or a thinking budget on a model that predates adaptive thinking),
 * OpenAI to a reasoning effort, Google to a thinking level or budget. The
 * OpenAI-compatible adapter would forward it as a raw `reasoning_effort`, which
 * an endpoint that does not know the field can refuse, so those providers are
 * left out.
 */
const REASONING_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

/**
 * The OpenAI models whose adapter capability table lists the `none` effort
 * (`supportedReasoningEfforts` in `@ai-sdk/openai`'s
 * `getOpenAILanguageModelCapabilities`, which the package does not export).
 * Every other OpenAI model is sent `none` unchecked by the adapter, and an
 * older reasoning model refuses it, so `off` is sent only to these.
 */
const OPENAI_NONE_EFFORT_MODELS = new Set(['gpt-6-sol', 'gpt-6-luna']);

/**
 * What an Agent version's `reasoning` asks of a call to `spec`, as the AI SDK's
 * `reasoning` call setting, or undefined to send nothing.
 *
 * - null (no opinion) sends nothing, so the model runs at its provider's
 *   default — what every call did before the field existed.
 * - `low`, `medium` and `high` pass through to Anthropic, OpenAI and Google.
 * - `off` is sent as `none` only where the installed adapter knows the model
 *   accepts it, or translates it into what the model accepts: every Anthropic
 *   model (the adapter holds each model's thinking capabilities, and runs a
 *   model that cannot turn thinking off at its lowest setting), and the OpenAI
 *   models in {@link OPENAI_NONE_EFFORT_MODELS}. Anywhere else — another OpenAI
 *   model, any Google model, whose adapter has no data on which models may stop
 *   thinking — `off` sends nothing and the model runs at its default.
 *
 * An OpenAI credential with an `apiBase` is bound to the Chat Completions
 * adapter (`lib/models.ts`), which forwards a raw `reasoning_effort` for any
 * model to whatever gateway the base names, so it is sent nothing, as an
 * OpenAI-compatible provider is. A level is a preference: a call must never
 * fail over one.
 */
export function reasoningCallSetting(
  spec: string,
  level: ReasoningLevel | null | undefined,
  apiBase?: string | null
): ReasoningCallSetting | undefined {
  if (!level) {
    return undefined;
  }
  let provider: string;
  let modelId: string;
  try {
    ({ modelId, provider } = parseProviderModelSpec(spec));
  } catch {
    return undefined;
  }
  if (!REASONING_PROVIDERS.has(provider)) {
    return undefined;
  }
  if (provider === 'openai' && apiBase) {
    return undefined;
  }
  if (level !== 'off') {
    return level;
  }
  if (provider === 'anthropic') {
    return 'none';
  }
  if (provider === 'openai' && OPENAI_NONE_EFFORT_MODELS.has(modelId)) {
    return 'none';
  }
  return undefined;
}

/**
 * Applies a reasoning setting to every call through the model, unless the
 * caller set one itself. Bound into the model rather than passed at each call
 * site, so the Mastra loop, a structured-output call and Pi's bridge all honour
 * the Agent's level the same way.
 */
export function reasoningMiddleware(setting: ReasoningCallSetting): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) =>
      params.reasoning === undefined ? { ...params, reasoning: setting } : params,
  };
}

/**
 * The Claude Code harness's effort for a level, or undefined to leave the
 * harness at its own default. The harness chooses its thinking configuration
 * per model, and some models refuse thinking turned off, so `off` is not
 * forced on it.
 */
export function claudeCodeEffort(
  level: ReasoningLevel | null | undefined
): 'low' | 'medium' | 'high' | undefined {
  return level === 'low' || level === 'medium' || level === 'high' ? level : undefined;
}
