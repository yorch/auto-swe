import { ApplicationFailure } from '@temporalio/activity';
import { trace } from '@opentelemetry/api';
import { prisma } from '@auto-swe/shared/db';
import type { BudgetTier } from '@auto-swe/shared/types/workflow';

const tracer = trace.getTracer('auto-swe-worker');

// Claude Opus 4.6 pricing (USD per token).
// If the model used by any agent changes, update these constants.
const PRICE_INPUT_PER_TOKEN = 15 / 1_000_000;   // $15 per 1M input tokens
const PRICE_OUTPUT_PER_TOKEN = 75 / 1_000_000;  // $75 per 1M output tokens

export const BUDGET_LIMITS: Record<BudgetTier, { inputTokens: number; outputTokens: number }> = {
  STANDARD: { inputTokens: 2_000_000,  outputTokens:   500_000 },
  LARGE:    { inputTokens: 8_000_000,  outputTokens: 2_000_000 },
  EPIC:     { inputTokens: 20_000_000, outputTokens: 5_000_000 },
};

export function calculateCostUsd(inputTokens: number, outputTokens: number): number {
  return inputTokens * PRICE_INPUT_PER_TOKEN + outputTokens * PRICE_OUTPUT_PER_TOKEN;
}

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Records LLM usage for a workflow after an agent.generate() call.
 * - Accumulates token counts and cost in the DB.
 * - Emits OTel span attributes for observability.
 * - Throws non-retryable BUDGET_EXCEEDED if the tier limit is breached.
 *
 * @param temporalWorkflowId - The Temporal workflow ID (used to look up the ActiveWorkflow record).
 * @param usage - Token usage from result.usage (Vercel AI SDK shape).
 * @param spanName - OTel span name for attribution (e.g., 'llm.implementer.iteration_1').
 */
export async function recordLlmUsage(
  temporalWorkflowId: string,
  usage: TokenUsage,
  spanName = 'llm.usage',
): Promise<void> {
  await tracer.startActiveSpan(spanName, async (span) => {
    try {
      const workflow = await prisma.activeWorkflow.findFirst({
        where: { temporalWorkflowId },
        select: { id: true, budgetTier: true, tokensInputUsed: true, tokensOutputUsed: true, costUsdAccrued: true },
      });

      if (!workflow) {
        // Non-fatal: workflow record may not exist in test/dev scenarios
        span.setAttribute('llm.workflow_found', false);
        return;
      }

      const callCost = calculateCostUsd(usage.promptTokens, usage.completionTokens);
      const newInput = workflow.tokensInputUsed + usage.promptTokens;
      const newOutput = workflow.tokensOutputUsed + usage.completionTokens;
      const newCost = workflow.costUsdAccrued + callCost;

      span.setAttributes({
        'llm.input_tokens': usage.promptTokens,
        'llm.output_tokens': usage.completionTokens,
        'llm.cost_usd': callCost,
        'workflow.budget_tier': workflow.budgetTier,
        'workflow.tokens_input_cumulative': newInput,
        'workflow.tokens_output_cumulative': newOutput,
        'workflow.cost_usd_cumulative': newCost,
      });

      // Write usage to DB before checking the budget limit.
      // This is intentional: we record actual consumption even when the limit
      // is breached, so the UI shows the real overage rather than the last
      // value before the limit was hit.
      await prisma.activeWorkflow.update({
        where: { id: workflow.id },
        data: { tokensInputUsed: newInput, tokensOutputUsed: newOutput, costUsdAccrued: newCost },
      });

      const tier = (workflow.budgetTier ?? 'STANDARD') as BudgetTier;
      const limits = BUDGET_LIMITS[tier];
      if (!limits) {
        throw new Error(`Unknown budget tier "${tier}" — update BUDGET_LIMITS in costTracking.ts`);
      }

      span.setAttributes({
        'workflow.budget_remaining_input_tokens': limits.inputTokens - newInput,
        'workflow.budget_remaining_output_tokens': limits.outputTokens - newOutput,
      });

      if (newInput > limits.inputTokens || newOutput > limits.outputTokens) {
        throw ApplicationFailure.nonRetryable(
          `Budget exceeded for tier ${tier}: ${newInput}/${limits.inputTokens} input tokens, ${newOutput}/${limits.outputTokens} output tokens used ($${newCost.toFixed(4)})`,
          'BUDGET_EXCEEDED',
          { tier, newInput, newOutput, newCost },
        );
      }
    } catch (e) {
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
}
