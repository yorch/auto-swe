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

  // Use Memory Agent to summarize the workflow
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

  // Generate embedding for the lesson summary
  const embedding = await generateEmbedding(lesson.lessonSummary);

  // Persist with embedding via raw SQL (Prisma doesn't support vector type natively)
  const lessonRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::vector, $6, $7::jsonb, now())
     RETURNING id`,
    workflow.id,
    repoId,
    lesson.rationale,
    lesson.lessonSummary,
    JSON.stringify(embedding),
    lesson.failureType,
    JSON.stringify(lesson.metadata ?? {})
  );

  return lessonRows[0]?.id ?? '';
}

/**
 * Phase-8 direct lesson recorder. Bypasses the LLM summarizer for cases where
 * the calling activity already knows exactly what happened (e.g. a merge
 * conflict resolver that succeeded, or a shell step that fixed a regression).
 * Generates the embedding for the supplied `lessonSummary` and writes one
 * `agent_lessons` row keyed to the current ActiveWorkflow.
 *
 * Returns the lesson id, or `null` if the linked `ActiveWorkflow` row can't
 * be resolved (best-effort path — the caller never fails its own work over a
 * memory hiccup).
 */
export async function recordLessonDirectly(input: {
  temporalWorkflowId: string;
  repoId: string;
  rationale: string;
  lessonSummary: string;
  failureType?: 'CI_FAILURE' | 'REVIEW_REJECTION' | 'SECURITY_VIOLATION' | 'MERGE_CONFLICT' | null;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const workflow = await prisma.activeWorkflow.findFirst({
      where: { temporalWorkflowId: input.temporalWorkflowId },
    });
    if (!workflow) return null;

    const embedding = await generateEmbedding(input.lessonSummary);
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::vector, $6, $7::jsonb, now())
       RETURNING id`,
      workflow.id,
      input.repoId,
      input.rationale,
      input.lessonSummary,
      JSON.stringify(embedding),
      input.failureType ?? null,
      JSON.stringify(input.metadata ?? {})
    );
    return rows[0]?.id ?? null;
  } catch {
    // Memory writes must never break the calling activity. The structured
    // lesson is nice-to-have; the actual code change is what matters.
    return null;
  }
}
