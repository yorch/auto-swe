import { prisma } from '@auto-swe/shared/db';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { MEMORY_SUMMARIZER_PROMPT } from '../agents/prompts.js';
import { currentWorkflowRunId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { assertBudgetAvailable, recordLlmUsage } from '../lib/costTracking.js';
import { insertMemoryItem } from '../lib/memoryStore.js';
import { getModel, resolveSystemPrompt } from '../lib/models.js';
import { requireRepoId } from '../lib/requireRepoId.js';

const LessonOutputSchema = z.object({
  failureType: z
    .enum(['CI_FAILURE', 'REVIEW_REJECTION', 'SECURITY_VIOLATION', 'MERGE_CONFLICT'])
    .nullable(),
  lessonSummary: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  rationale: z.string(),
});

type FailureType = z.infer<typeof LessonOutputSchema>['failureType'];

/**
 * Insert one memory_items row + its vector embedding. Shared by the
 * LLM-summarized path (`commitToMemory`) and the phase-8 direct recorder
 * (`recordLessonDirectly`). Delegates to the shared {@link insertMemoryItem}
 * helper (raw pgvector SQL lives there); this thin wrapper keeps the
 * repo-scoped SWE-lesson call sites stable.
 */
async function writeMemoryItemRow(input: {
  workflowId: string;
  repoId: string;
  rationale: string;
  lessonSummary: string;
  failureType: FailureType;
  metadata: Record<string, unknown> | null;
  skillsActive?: string[];
  workflowRunId?: string;
  agentKey?: string;
  model?: string;
  costUsd?: number;
}): Promise<string> {
  return insertMemoryItem({
    agentKey: input.agentKey,
    costUsd: input.costUsd,
    failureType: input.failureType,
    lessonSummary: input.lessonSummary,
    metadata: input.metadata,
    model: input.model,
    rationale: input.rationale,
    repoId: input.repoId,
    skillsActive: input.skillsActive,
    workflowId: input.workflowId,
    workflowRunId: input.workflowRunId,
  });
}

/**
 * Summarizes a completed workflow into a reusable lesson and persists it
 * with a vector embedding for future semantic search.
 */
export async function commitToMemory(
  temporalWorkflowId: string,
  /** Lessons are repo-scoped, so a run with no connection cannot write one. */
  repoId: string | null,
  systemPromptOverride?: string
): Promise<string> {
  const scopedRepoId = requireRepoId({ repoId }, 'commitToMemory');
  const workflow = await prisma.activeWorkflow.findFirst({
    include: {
      pullRequests: true,
      workRequest: true,
    },
    where: { temporalWorkflowId },
  });

  if (!workflow) {
    throw new Error(`Workflow not found: ${temporalWorkflowId}`);
  }

  const workflowRunId = await currentWorkflowRunId();

  const agentTracer = new AgentTracer();
  const start = Date.now();

  const activityCtx = await currentRequestContext();
  const skills = await loadAgentSkills('commitToMemory', activityCtx);
  const skillSuffix = skills
    .map((s) => s.promptText)
    .filter(Boolean)
    .join('\n\n');

  const basePrompt = await resolveSystemPrompt(
    'commitToMemory',
    MEMORY_SUMMARIZER_PROMPT,
    systemPromptOverride
  );
  const systemPrompt = skillSuffix ? `${basePrompt}\n\n${skillSuffix}` : basePrompt;

  const memoryAgent = new Agent({
    id: 'memory-summarizer',
    instructions: systemPrompt,
    model: await getModel('commitToMemory'),
    name: 'memory-summarizer',
  });

  const llmUserMessage = JSON.stringify({
    description: workflow.workRequest?.description,
    externalTicketId: workflow.workRequest?.externalTicketId,
    pullRequests: workflow.pullRequests.map((pr) => ({
      ciStatus: pr.ciStatus,
      prNumber: pr.prNumber,
      status: pr.status,
    })),
    status: workflow.currentStatus,
    temporalWorkflowId: workflow.temporalWorkflowId,
    workflowId: workflow.id,
  });

  try {
    await assertBudgetAvailable(temporalWorkflowId, 'commitToMemory');
    const result = await memoryAgent.generate([{ content: llmUserMessage, role: 'user' }], {
      structuredOutput: { schema: LessonOutputSchema },
    });

    let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
    if (result.usage) {
      attribution = await recordLlmUsage(
        temporalWorkflowId,
        'commitToMemory',
        result.usage,
        'llm.commit_to_memory'
      );
    }

    if (!result.object) {
      throw new Error('Memory summarizer agent did not return structured output');
    }
    const lesson = result.object as z.infer<typeof LessonOutputSchema>;

    agentTracer.addLlmResponse({
      costUsd: attribution.costUsd,
      durationMs: Date.now() - start,
      inputJson: { systemPrompt, userMessage: llmUserMessage },
      inputTokens: attribution.inputTokens,
      model: attribution.modelSpec || undefined,
      outputJson: {
        failureType: lesson.failureType,
        lessonSummary: lesson.lessonSummary,
        rationale: lesson.rationale,
      },
      outputTokens: attribution.outputTokens,
      role: 'commitToMemory',
    });

    const lessonId = await writeMemoryItemRow({
      agentKey: 'commitToMemory',
      costUsd: attribution.costUsd,
      failureType: lesson.failureType,
      lessonSummary: lesson.lessonSummary,
      metadata: lesson.metadata,
      model: attribution.modelSpec || undefined,
      rationale: lesson.rationale,
      repoId: scopedRepoId,
      skillsActive: skills.map((s) => s.name),
      workflowId: workflow.id,
      workflowRunId,
    });

    agentTracer.addActivityEvent({
      name: 'memory.lesson_written',
      outputJson: { failureType: lesson.failureType, lessonId },
    });

    return lessonId;
  } catch (e) {
    agentTracer.addLlmResponse({
      durationMs: Date.now() - start,
      error: (e as Error).message,
      inputJson: { systemPrompt, userMessage: llmUserMessage },
      role: 'commitToMemory',
    });
    throw e;
  } finally {
    await persistActivityTrace(agentTracer, 'commitToMemory');
  }
}

/**
 * Phase-8 direct lesson recorder. Bypasses the LLM summarizer for callers
 * that already know exactly what happened (the merge-conflict resolver and
 * shell-step activity). Returns the lesson id, or `null` if the linked
 * `ActiveWorkflow` can't be resolved or the insert throws — best-effort, so
 * the caller never fails its own work over a memory hiccup.
 */
export async function recordLessonDirectly(input: {
  temporalWorkflowId: string;
  repoId: string;
  rationale: string;
  lessonSummary: string;
  failureType?: FailureType;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const workflow = await prisma.activeWorkflow.findFirst({
      where: { temporalWorkflowId: input.temporalWorkflowId },
    });
    if (!workflow) {
      return null;
    }
    return await writeMemoryItemRow({
      failureType: input.failureType ?? null,
      lessonSummary: input.lessonSummary,
      metadata: input.metadata ?? null,
      rationale: input.rationale,
      repoId: input.repoId,
      workflowId: workflow.id,
    });
  } catch (err) {
    // Log so silent failures stay observable, but never propagate.
    // eslint-disable-next-line no-console
    console.warn(`recordLessonDirectly: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Hard cap on best-effort memory writes from inside long-running activities
 * (resolver, shell-step). The embedding call goes to an external provider; a
 * slow/hung response shouldn't extend the parent activity past its timeout
 * once the actual work has succeeded.
 */
const MEMORY_HOOK_TIMEOUT_MS = 5_000;

/**
 * Fire-and-forget wrapper around {@link recordLessonDirectly} for callers
 * that don't want to wait on the embedding round-trip. Returns a promise the
 * caller can await with a guaranteed {@link MEMORY_HOOK_TIMEOUT_MS} ceiling;
 * the underlying write keeps running in the background even if we time out.
 * Use this from activities whose primary work has already succeeded.
 */
export async function recordLessonBackground(
  input: Parameters<typeof recordLessonDirectly>[0]
): Promise<void> {
  const write = recordLessonDirectly(input).catch(() => null);
  await Promise.race([
    write,
    new Promise<void>((resolve) => setTimeout(resolve, MEMORY_HOOK_TIMEOUT_MS)),
  ]);
}
