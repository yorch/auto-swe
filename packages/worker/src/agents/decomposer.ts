/**
 * Feature-level decomposer agent (phase 3 — configurable workflows).
 *
 * Given a work request, decides whether the task naturally splits into
 * independent feature-level subtasks. Each returned subtask runs in its own
 * Docker workspace and produces its own branch, which is later merged into
 * the parent feature branch by the `mergeBranches` activity.
 *
 * Hard contract:
 *   - 1 ≤ subtasks ≤ MAX_SUBTASKS
 *   - subtask.id is lowercase kebab-case, ≤40 chars, unique within the response
 *   - subtask.description is self-contained (implementer agent will see only it)
 *
 * If decomposition isn't beneficial, the agent returns a single subtask
 * covering the whole work request — that keeps the spec uniform (the fan-out
 * always runs at least one branch) without forcing every team to write a
 * cond-around-fanOut.
 */

import type {
  DecompositionResult,
  RepoWorkRequest,
  Subtask,
} from '@auto-swe/shared/types/workflow';
import { Agent } from '@mastra/core/agent';
import { trace } from '@opentelemetry/api';
import { z } from 'zod';
import { currentWorkflowId } from '../lib/activityContext.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { assertBudgetAvailable, type LlmAttribution, recordLlmUsage } from '../lib/costTracking.js';
import { failedCallAttribution } from '../lib/llmAttribution.js';
import { getBoundModel } from '../lib/models.js';
import { assertRolePricedForUsdCap } from '../lib/usdCapGuard.js';
import { DECOMPOSER_AGENT_PROMPT } from './prompts.js';

const otelTracer = trace.getTracer('auto-swe-worker');

export const MAX_SUBTASKS = 8;
const SUBTASK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

const SubtaskSchema = z.object({
  description: z.string().min(10).max(4000),
  files: z.array(z.string().min(1).max(200)).max(40).optional(),
  id: z.string().regex(SUBTASK_ID_RE),
  title: z.string().min(3).max(120),
});

const DecomposerOutputSchema = z.object({
  rationale: z.string().max(2000).optional(),
  subtasks: z.array(SubtaskSchema).min(1).max(MAX_SUBTASKS),
});

export async function planDecomposition(
  request: RepoWorkRequest,
  tracer?: AgentTracer,
  systemPromptOverride?: string,
  skillSuffix?: string
): Promise<DecompositionResult> {
  return otelTracer.startActiveSpan(
    'llm.plan_decomposition',
    { attributes: { 'request.ticket': request.externalTicketId } },
    async (span) => {
      const start = Date.now();
      let systemPrompt = '';
      let llmUserMessage = '';
      let modelSpec: string | undefined;
      let recorded: LlmAttribution | undefined;
      try {
        // The decomposer persona: its own prompt row, and the planner's model
        // through `inheritsModelFrom` unless the row overrides it.
        // Resolved once: the model called, the price checked, the cost recorded
        // and the prompt used all come from this one resolution.
        const { model, spec, systemPrompt: rowPrompt } = await getBoundModel('decomposer');
        modelSpec = spec;
        span.setAttribute('llm.model', modelSpec);
        const basePrompt = systemPromptOverride || (rowPrompt ?? DECOMPOSER_AGENT_PROMPT);
        systemPrompt = skillSuffix ? `${basePrompt}\n\n${skillSuffix}` : basePrompt;
        const agent = new Agent({
          id: 'feature-decomposer',
          instructions: systemPrompt,
          model,
          name: 'feature-decomposer',
        });

        llmUserMessage = JSON.stringify({
          description: request.description,
          externalTicketId: request.externalTicketId,
          maxSubtasks: MAX_SUBTASKS,
        });
        await assertRolePricedForUsdCap('decomposer', spec);
        await assertBudgetAvailable('decomposer');
        const result = await agent.generate([{ content: llmUserMessage, role: 'user' }], {
          structuredOutput: { schema: DecomposerOutputSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = recorded = await recordLlmUsage(
            currentWorkflowId(),
            'decomposer',
            result.usage,
            'llm.decomposer',
            spec
          );
        }

        // Validate rather than cast: an object that fails the schema (too many
        // subtasks, a malformed id) is treated like no structured output.
        const validated = DecomposerOutputSchema.safeParse(result.object);
        if (!validated.success) {
          // Fall back to a single-subtask plan rather than failing the run.
          const fallback = singletonFallback(
            request,
            result.object
              ? 'decomposer returned structured output that failed validation'
              : 'decomposer returned no structured output'
          );
          tracer?.addLlmResponse({
            // The call was made and paid for even though its output was unusable.
            ...failedCallAttribution(undefined, modelSpec, recorded),
            durationMs: Date.now() - start,
            error: result.object
              ? 'invalid structured output — used singleton fallback'
              : 'no structured output — used singleton fallback',
            inputJson: { systemPrompt, userMessage: llmUserMessage },
            outputJson: fallback,
            role: 'decomposer',
          });
          return fallback;
        }

        const parsed = validated.data;
        const subtasks = dedupeIds(parsed.subtasks);
        const decompositionResult = {
          ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
          subtasks,
        };

        span.setAttribute('decomposer.subtask_count', subtasks.length);
        tracer?.addLlmResponse({
          costUsd: attribution.costUsd,
          durationMs: Date.now() - start,
          inputJson: { systemPrompt, userMessage: llmUserMessage },
          inputTokens: attribution.inputTokens,
          model: attribution.modelSpec || undefined,
          outputJson: {
            rationale: parsed.rationale,
            subtaskCount: subtasks.length,
            subtasks: subtasks.map((s) => ({ id: s.id, title: s.title })),
          },
          outputTokens: attribution.outputTokens,
          role: 'decomposer',
        });

        return decompositionResult;
      } catch (e) {
        tracer?.addLlmResponse({
          ...failedCallAttribution(e, modelSpec, recorded),
          durationMs: Date.now() - start,
          error: (e as Error).message,
          inputJson: { systemPrompt, userMessage: llmUserMessage },
          role: 'decomposer',
        });
        span.recordException(e as Error);
        throw e;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Drop duplicate IDs (the schema validates shape but not uniqueness). Keep
 * the first occurrence; duplicates would produce conflicting branch names.
 */
function dedupeIds(subtasks: Subtask[]): Subtask[] {
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (const s of subtasks) {
    if (seen.has(s.id)) {
      continue;
    }
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

function singletonFallback(request: RepoWorkRequest, reason: string): DecompositionResult {
  return {
    rationale: `Single-subtask fallback: ${reason}`,
    subtasks: [
      {
        description: request.description,
        id: 'main',
        title: request.externalTicketId || 'main',
      },
    ],
  };
}
