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
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel, getModelSpec, resolveSystemPrompt } from '../lib/models.js';
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
      try {
        const modelSpec = await getModelSpec('planner');
        const model = await getModel('planner');
        span.setAttribute('llm.model', modelSpec);
        const basePrompt = await resolveSystemPrompt(
          'planner',
          DECOMPOSER_AGENT_PROMPT,
          systemPromptOverride
        );
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
        const result = await agent.generate([{ content: llmUserMessage, role: 'user' }], {
          structuredOutput: { schema: DecomposerOutputSchema },
        });

        let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
        if (result.usage) {
          attribution = await recordLlmUsage(
            currentWorkflowId(),
            'planner',
            result.usage,
            'llm.decomposer'
          );
        }

        if (!result.object) {
          // Fall back to a single-subtask plan rather than failing the run.
          const fallback = singletonFallback(request, 'decomposer returned no structured output');
          tracer?.addLlmResponse({
            durationMs: Date.now() - start,
            error: 'no structured output — used singleton fallback',
            inputJson: { systemPrompt, userMessage: llmUserMessage },
            outputJson: fallback,
            role: 'planner',
          });
          return fallback;
        }

        const parsed = result.object as z.infer<typeof DecomposerOutputSchema>;
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
          role: 'planner',
        });

        return decompositionResult;
      } catch (e) {
        tracer?.addLlmResponse({
          durationMs: Date.now() - start,
          error: (e as Error).message,
          inputJson: { systemPrompt, userMessage: llmUserMessage },
          role: 'planner',
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
