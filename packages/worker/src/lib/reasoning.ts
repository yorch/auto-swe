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
 * OpenAI to a reasoning effort its model supports, Google to a thinking level
 * or budget. The OpenAI-compatible adapter would forward it as a raw
 * `reasoning_effort`, which an endpoint that does not know the field can
 * refuse, so those providers are left out.
 */
const REASONING_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

/**
 * What an Agent version's `reasoning` asks of a call to `spec`, as the AI SDK's
 * `reasoning` call setting, or undefined to send nothing.
 *
 * - null (no opinion) sends nothing, so the model runs at its provider's
 *   default — what every call did before the field existed.
 * - `off` asks for no reasoning (`none`). A model that cannot turn its thinking
 *   off is held to the least its adapter allows instead.
 * - `low`, `medium` and `high` pass through.
 *
 * A provider with no mapping gets nothing: a level is a preference, and a call
 * must never fail over one.
 */
export function reasoningCallSetting(
  spec: string,
  level: ReasoningLevel | null | undefined
): ReasoningCallSetting | undefined {
  if (!level) {
    return undefined;
  }
  let provider: string;
  try {
    ({ provider } = parseProviderModelSpec(spec));
  } catch {
    return undefined;
  }
  if (!REASONING_PROVIDERS.has(provider)) {
    return undefined;
  }
  return level === 'off' ? 'none' : level;
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
