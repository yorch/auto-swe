import { prisma } from '@auto-swe/shared/db';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { MEMORY_SUMMARIZER_PROMPT } from '../agents/prompts.js';
import { generateEmbedding } from '../lib/embeddings.js';
import { getModel } from '../lib/models.js';

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
 * Insert one agent_lessons row + its vector embedding. Shared by the
 * LLM-summarized path (`commitToMemory`) and the phase-8 direct recorder
 * (`recordLessonDirectly`). Prisma doesn't support pgvector natively, hence
 * the raw SQL.
 */
async function writeAgentLessonRow(input: {
  workflowId: string;
  repoId: string;
  rationale: string;
  lessonSummary: string;
  failureType: FailureType;
  metadata: Record<string, unknown> | null;
}): Promise<string> {
  const embedding = await generateEmbedding(input.lessonSummary);
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::vector, $6, $7::jsonb, now())
     RETURNING id`,
    input.workflowId,
    input.repoId,
    input.rationale,
    input.lessonSummary,
    JSON.stringify(embedding),
    input.failureType,
    JSON.stringify(input.metadata ?? {})
  );
  return rows[0]?.id ?? '';
}

/**
 * Summarizes a completed workflow into a reusable lesson and persists it
 * with a vector embedding for future semantic search.
 */
export async function commitToMemory(temporalWorkflowId: string, repoId: string): Promise<string> {
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

  const memoryAgent = new Agent({
    id: 'memory-summarizer',
    instructions: MEMORY_SUMMARIZER_PROMPT,
    model: getModel('commitToMemory'),
    name: 'memory-summarizer',
  });

  const result = await memoryAgent.generate(
    [
      {
        content: JSON.stringify({
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
        }),
        role: 'user',
      },
    ],
    { structuredOutput: { schema: LessonOutputSchema } }
  );

  if (!result.object) {
    throw new Error('Memory summarizer agent did not return structured output');
  }
  const lesson = result.object as z.infer<typeof LessonOutputSchema>;

  return writeAgentLessonRow({
    failureType: lesson.failureType,
    lessonSummary: lesson.lessonSummary,
    metadata: lesson.metadata,
    rationale: lesson.rationale,
    repoId,
    workflowId: workflow.id,
  });
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
    if (!workflow) return null;
    return await writeAgentLessonRow({
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
