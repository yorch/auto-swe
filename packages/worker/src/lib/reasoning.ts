import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import type { ReasoningLevel } from '@auto-swe/shared/types/api';
import type { LanguageModelMiddleware } from 'ai';

type CallParams = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

/** The AI SDK's provider-neutral reasoning call setting. */
export type ReasoningCallSetting = NonNullable<CallParams['reasoning']>;

/**
 * The OpenAI models whose adapter capability table lists the `none` effort
 * (`supportedReasoningEfforts` in `@ai-sdk/openai`'s
 * `getOpenAILanguageModelCapabilities`, which the package does not export).
 * Every other OpenAI model is sent `none` unchecked by the adapter, and an
 * older reasoning model refuses it, so `off` is sent only to these.
 */
const OPENAI_NONE_EFFORT_MODELS = new Set(['gpt-6-sol', 'gpt-6-luna']);

/**
 * Anthropic ids the adapter's capability table (`getModelCapabilities` in
 * `@ai-sdk/anthropic`, not exported) files with the Claude 2 and Claude 3
 * generations, none of which has extended thinking — except Claude 3.7, which
 * that pattern also matches and which does think.
 */
const ANTHROPIC_PRE_THINKING = /claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/;
const ANTHROPIC_THINKING_3_7 = /claude-3-7(?:-|$)/;

/**
 * Whether the Anthropic adapter would turn a level into a thinking request the
 * model accepts: any `claude-` id outside the pre-thinking generations (an
 * unknown newer id is treated as the newest, as the adapter does), and Claude
 * 3.7. Any other id under the provider gets nothing.
 */
function anthropicThinks(modelId: string): boolean {
  if (!modelId.includes('claude-')) {
    return false;
  }
  return !ANTHROPIC_PRE_THINKING.test(modelId) || ANTHROPIC_THINKING_3_7.test(modelId);
}

/**
 * The Gemini families `@ai-sdk/google` treats as thinking-capable, matched as its
 * `getGoogleModelCapabilities` does (not exported): Gemini 2.5, and every
 * `gemini-` id that is neither a Gemini 2 id nor a known pre-Gemini-2 one (the
 * adapter's Gemini 3 feature set, which an unrecognised newer id inherits).
 * The adapter would send a thinking budget to any other id, Gemini 2.0 and
 * Gemma included, which those models refuse.
 */
const GEMINI_25 = /(^|\/)gemini-2\.5(?:[.-]|$)/i;
const GEMINI_ANY = /(^|\/)gemini-/i;
const GEMINI_2 = /(^|\/)gemini-2(?:[.-]|$)/i;
const GEMINI_PRE_2 = [
  /(^|\/)gemini-1(?:[.-]|$)/i,
  /(^|\/)gemini-pro(?:-vision)?$/i,
  /(^|\/)gemini-robotics-er-1\.5(?:[.-]|$)/i,
];

function googleThinks(modelId: string): boolean {
  if (GEMINI_25.test(modelId)) {
    return true;
  }
  return (
    GEMINI_ANY.test(modelId) &&
    !GEMINI_2.test(modelId) &&
    !GEMINI_PRE_2.some((pattern) => pattern.test(modelId))
  );
}

/**
 * What an Agent version's `reasoning` asks of a call to `spec`, as the AI SDK's
 * `reasoning` call setting, or undefined to send nothing.
 *
 * - null (no opinion) sends nothing, so the model runs at its provider's
 *   default — what every call did before the field existed.
 * - `low`, `medium` and `high` pass through to an Anthropic or Google model
 *   that can think ({@link anthropicThinks}, {@link googleThinks}) and to any
 *   OpenAI model (its adapter sends an effort only to a reasoning model, and
 *   drops one a GPT-6 model does not list).
 * - `off` is sent as `none` only where the installed adapter knows the model
 *   accepts it, or translates it into what the model accepts: an Anthropic
 *   model that can think (the adapter holds each one's thinking capabilities,
 *   and runs a model that cannot turn thinking off at its lowest setting), and
 *   the OpenAI models in {@link OPENAI_NONE_EFFORT_MODELS}. Anywhere else —
 *   another OpenAI model, any Google model, whose adapter has no data on which
 *   models may stop thinking — `off` sends nothing and the model runs at its
 *   default.
 *
 * Only the built-in providers' adapters map the setting per model. The
 * OpenAI-compatible adapter would forward it as a raw `reasoning_effort`, which
 * an endpoint that does not know the field can refuse, so those providers are
 * sent nothing. An OpenAI credential with an `apiBase` is bound to the Chat Completions
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
  switch (provider) {
    case 'anthropic':
      if (!anthropicThinks(modelId)) {
        return undefined;
      }
      return level === 'off' ? 'none' : level;
    case 'openai':
      if (apiBase) {
        return undefined;
      }
      if (level === 'off') {
        return OPENAI_NONE_EFFORT_MODELS.has(modelId) ? 'none' : undefined;
      }
      return level;
    case 'google':
      return level !== 'off' && googleThinks(modelId) ? level : undefined;
    default:
      return undefined;
  }
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
