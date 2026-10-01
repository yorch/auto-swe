import { ApplicationFailure } from '@temporalio/activity';
import type { LlmAttribution } from './costTracking.js';

/**
 * What a failed LLM call's trace row should carry, so the usage report prices
 * it and blames the right model:
 *  - `recorded` — usage was already accrued and something after it threw
 *    (missing structured output, a parse error): the call was paid for.
 *  - a `BUDGET_EXCEEDED` from the post-call check: likewise paid for; its
 *    attribution rides on the failure.
 *  - anything else: the configured model, with no tokens.
 */
export function failedCallAttribution(
  err: unknown,
  modelSpec: string | undefined,
  recorded?: LlmAttribution
): { costUsd?: number; inputTokens?: number; model?: string; outputTokens?: number } {
  if (recorded) {
    return {
      costUsd: recorded.costUsd,
      inputTokens: recorded.inputTokens,
      model: recorded.modelSpec || modelSpec || undefined,
      outputTokens: recorded.outputTokens,
    };
  }
  if (err instanceof ApplicationFailure && err.type === 'BUDGET_EXCEEDED') {
    const a = (err.details?.[0] as { attribution?: LlmAttribution } | undefined)?.attribution;
    if (a) {
      return {
        costUsd: a.costUsd,
        inputTokens: a.inputTokens,
        model: a.modelSpec,
        outputTokens: a.outputTokens,
      };
    }
  }
  return { model: modelSpec || undefined };
}
